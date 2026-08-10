/**
 * SQLite 数据库结构定义。
 * 表名与字段与需求文档一致，另补充文件大小、页数、状态等实用字段。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL DEFAULT '',
  library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pdfs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  size INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER,
  has_outline INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'library',
  created_time TEXT NOT NULL,
  updated_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pdf_tags (
  pdf_id INTEGER NOT NULL REFERENCES pdfs(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (pdf_id, tag_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_id INTEGER NOT NULL UNIQUE REFERENCES pdfs(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL DEFAULT '',
  /** 笔记主文件（Markdown）的绝对路径：data/notes/<PDF标题>/<PDF标题> 笔记.md */
  note_file TEXT,
  /** 笔记目录（含主 md 与截图 assets/）的绝对路径：data/notes/<PDF标题> */
  note_dir TEXT,
  updated_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_id INTEGER NOT NULL REFERENCES pdfs(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL DEFAULT '#fde047',
  created_time TEXT NOT NULL,
  updated_time TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pdfs_folder ON pdfs(folder_id);
CREATE INDEX IF NOT EXISTS idx_pdfs_title ON pdfs(title);
CREATE INDEX IF NOT EXISTS idx_pdf_tags_pdf ON pdf_tags(pdf_id);
CREATE INDEX IF NOT EXISTS idx_pdf_tags_tag ON pdf_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_notes_pdf ON notes(pdf_id);
CREATE INDEX IF NOT EXISTS idx_annotations_pdf ON annotations(pdf_id);
PRAGMA user_version = 7;
`;
