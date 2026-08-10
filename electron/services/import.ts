import fs from 'fs';
import path from 'path';
import type { ImportResult } from '../../src/shared/types';
import { getLibraryPdfDir } from '../db/database';
import { repository } from '../db/repository';
import { guessHasOutline, guessPageCount } from './pdfMeta';

export interface ImportOptions {
  /** Replace metadata (instead of skipping) when the file already exists */
  replace?: boolean;
}

function isInside(target: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Next free filename: name.pdf / name (1).pdf / name (2).pdf ... */
function uniqueTargetPath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

/** Next free directory name: name / name (1) / name (2) ... */
function uniqueDirName(dir: string, name: string): string {
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${name} (${i})`;
    i++;
  }
  return candidate;
}

async function walkDir(dir: string, files: string[], errors: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, files, errors);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      files.push(full);
    }
  }
}

/**
 * Import PDFs into the managed Library tree.
 * - 单个 PDF：复制到目标文件夹；
 * - 文件夹：以「整目录导入」方式复制到目标文件夹下（保留目录结构），
 *   并在数据库中建立对应的文件夹层级，PDF 归入各自的子文件夹。
 */
export async function importPdfs(
  inputPaths: string[],
  folderId: number | null,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const libraryDir = getLibraryPdfDir();
  fs.mkdirSync(libraryDir, { recursive: true });
  const targetDir = repository.folderFsDir(folderId);

  const existingByLower = new Map(
    repository.getAllFilepaths().map((f) => [f.toLowerCase(), f] as const),
  );
  const seenSources = new Set<string>();
  const counts = { imported: 0, skipped: 0 };
  const errors: string[] = [];

  const registerPdf = async (
    filePath: string,
    folderIdForPdf: number | null,
  ): Promise<void> => {
    const lower = filePath.toLowerCase();
    if (existingByLower.has(lower)) {
      if (opts.replace) {
        repository.updatePdfByPath(filePath);
        counts.imported++;
      } else {
        counts.skipped++;
      }
      return;
    }
    const st = await fs.promises.stat(filePath);
    repository.insertPdf({
      filename: path.basename(filePath),
      filepath: filePath,
      title: path.basename(filePath).replace(/\.pdf$/i, ''),
      folderId: folderIdForPdf,
      size: st.size,
      pageCount: guessPageCount(filePath),
      hasOutline: guessHasOutline(filePath),
    });
    existingByLower.set(lower, filePath);
    counts.imported++;
  };

  const importFile = async (source: string): Promise<void> => {
    let finalPath = '';
    const alreadyManaged = isInside(source, libraryDir);
    try {
      finalPath = alreadyManaged ? source : uniqueTargetPath(targetDir, path.basename(source));
      if (!alreadyManaged) {
        await fs.promises.copyFile(source, finalPath);
      }
      await registerPdf(finalPath, folderId);
    } catch (err) {
      if (!alreadyManaged && finalPath && fs.existsSync(finalPath)) {
        try {
          fs.unlinkSync(finalPath);
        } catch {
          /* ignore */
        }
      }
      errors.push(`${path.basename(source)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const importDirectory = async (sourceDir: string): Promise<void> => {
    try {
      // 源目录已在库内：不复制，直接按库内路径注册
      if (isInside(sourceDir, libraryDir)) {
        const files: string[] = [];
        await walkDir(sourceDir, files, errors);
        for (const f of files) {
          const rel = path.relative(libraryDir, f);
          const relDir = path.dirname(rel).split(path.sep).filter(Boolean).join('/');
          const folder = relDir ? repository.ensureFolderByRelPath(relDir) : null;
          await registerPdf(f, folder?.id ?? null);
        }
        return;
      }

      // 外部文件夹：把其中所有 PDF 直接导入目标文件夹（不保留目录结构）
      const files: string[] = [];
      await walkDir(sourceDir, files, errors);
      for (const f of files) {
        try {
          const finalPath = uniqueTargetPath(targetDir, path.basename(f));
          await fs.promises.copyFile(f, finalPath);
          await registerPdf(finalPath, folderId);
        } catch (err) {
          errors.push(`${path.basename(f)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`${path.basename(sourceDir)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  for (const input of inputPaths) {
    const lower = input.toLowerCase();
    if (seenSources.has(lower)) continue;
    seenSources.add(lower);
    try {
      const st = await fs.promises.stat(input);
      if (st.isDirectory()) {
        await importDirectory(input);
      } else if (st.isFile() && input.toLowerCase().endsWith('.pdf')) {
        await importFile(input);
      }
    } catch (err) {
      errors.push(`${path.basename(input)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported: counts.imported, skipped: counts.skipped, errors };
}
