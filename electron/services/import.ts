import fs from 'fs';
import path from 'path';
import type { ImportResult } from '../../src/shared/types';
import { getLibraryPdfDir } from '../db/database';
import { repository } from '../db/repository';
import { guessPageCount } from './pdfMeta';

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

async function collectFiles(inputPaths: string[], files: string[], errors: string[]): Promise<void> {
  for (const p of inputPaths) {
    try {
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) {
        await walkDir(p, files, errors);
      } else if (st.isFile() && p.toLowerCase().endsWith('.pdf')) {
        files.push(p);
      }
    } catch (err) {
      errors.push(`${path.basename(p)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
 * Import PDFs into the managed Library tree. The target folder is a REAL
 * directory inside Documents/MinePDF/Library (created when the folder is made
 * in the app), so the Explorer and the app always see the same structure.
 */
export async function importPdfs(
  inputPaths: string[],
  folderId: number | null,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const files: string[] = [];
  const errors: string[] = [];
  await collectFiles(inputPaths, files, errors);

  const libraryDir = getLibraryPdfDir();
  fs.mkdirSync(libraryDir, { recursive: true });
  const targetDir = repository.folderFsDir(folderId);

  const existingByLower = new Map(
    repository.getAllFilepaths().map((f) => [f.toLowerCase(), f] as const),
  );
  let imported = 0;
  let skipped = 0;
  const seenSources = new Set<string>();

  for (const source of files) {
    const sourceLower = source.toLowerCase();
    if (seenSources.has(sourceLower)) {
      continue;
    }
    seenSources.add(sourceLower);

    let finalPath = '';
    const alreadyManaged = isInside(source, libraryDir);
    try {
      finalPath = alreadyManaged ? source : uniqueTargetPath(targetDir, path.basename(source));
      if (!alreadyManaged) {
        await fs.promises.copyFile(source, finalPath);
      }

      const lower = finalPath.toLowerCase();
      if (existingByLower.has(lower)) {
        if (opts.replace) {
          repository.updatePdfByPath(finalPath);
          imported++;
        } else {
          skipped++;
        }
        continue;
      }

      const st = await fs.promises.stat(finalPath);
      repository.insertPdf({
        filename: path.basename(finalPath),
        filepath: finalPath,
        title: path.basename(finalPath).replace(/\.pdf$/i, ''),
        folderId,
        size: st.size,
        pageCount: guessPageCount(finalPath),
      });
      existingByLower.set(lower, finalPath);
      imported++;
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
  }

  return { imported, skipped, errors };
}
