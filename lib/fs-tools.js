'use strict';

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');

const MAX_READ = 400 * 1024;

function looksBinary(buffer) {
  const len = Math.min(buffer.length, 4096);
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readFileTool({ filePath = '', offset = 1, limit = 1200 } = {}) {
  let target;
  try {
    target = workspace.resolvePath(filePath);
  } catch (error) {
    return { error: error.message };
  }
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return { error: `${target} — это папка. Используй list_dir.` };
    if (stat.size > MAX_READ) {
      return { error: `Файл слишком большой (${humanSize(stat.size)} > ${humanSize(MAX_READ)}). Прочитай часть через offset/limit или используй list_dir.` };
    }
    const buffer = fs.readFileSync(target);
    if (looksBinary(buffer)) return { error: `${target} — бинарный файл (${humanSize(stat.size)}), текст не извлечён.` };
    const text = buffer.toString('utf8');
    const allLines = text.split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const count = Math.max(1, Math.min(4000, Number(limit) || 1200));
    const slice = allLines.slice(start - 1, start - 1 + count);
    const numbered = slice.map((line, index) => `${String(start + index).padStart(5, ' ')}│ ${line}`).join('\n');
    const lastLine = start - 1 + slice.length;
    const footer = lastLine < allLines.length ? `\n\n… показано строк ${start}–${lastLine} из ${allLines.length}. Продолжи с offset=${lastLine + 1}.` : `\n\n(конец файла, всего ${allLines.length} строк)`;
    return { content: `Файл: ${target}\n${numbered}${footer}` };
  } catch (error) {
    return { error: `Не удалось прочитать ${target}: ${error.message}` };
  }
}

function writeFileTool({ filePath = '', content = '' } = {}) {
  let target;
  try {
    target = workspace.resolvePath(filePath);
  } catch (error) {
    return { error: error.message };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
    const size = fs.statSync(target).size;
    return { content: `${existed ? 'Обновлён' : 'Создан'} файл ${target} (${humanSize(size)}, ${String(content ?? '').length} символов).` };
  } catch (error) {
    return { error: `Не удалось записать ${target}: ${error.message}` };
  }
}

function editFileTool({ filePath = '', oldString = '', newString = '', replaceAll = false } = {}) {
  let target;
  try {
    target = workspace.resolvePath(filePath);
  } catch (error) {
    return { error: error.message };
  }
  try {
    if (!oldString) return { error: 'oldString не может быть пустым. Для создания файла используй write_file.' };
    const original = fs.readFileSync(target, 'utf8');
    if (!original.includes(oldString)) {
      return { error: `Фрагмент не найден в ${target}. Прочитай файл заново и передай точный текст (включая отступы).` };
    }
    const occurrences = original.split(oldString).length - 1;
    let updated;
    if (replaceAll) {
      updated = original.split(oldString).join(newString);
    } else {
      if (occurrences > 1) {
        return { error: `Фрагмент встречается ${occurrences} раз. Уточни oldString или передай replaceAll=true.` };
      }
      updated = original.replace(oldString, newString);
    }
    fs.writeFileSync(target, updated, 'utf8');
    return { content: `Файл ${target} обновлён (заменено вхождений: ${replaceAll ? occurrences : 1}).` };
  } catch (error) {
    return { error: `Не удалось изменить ${target}: ${error.message}` };
  }
}

function listDirTool({ dirPath = '', depth = 2 } = {}) {
  let target;
  try {
    target = workspace.resolvePath(dirPath, { allowEmpty: true });
  } catch (error) {
    return { error: error.message };
  }
  const maxDepth = Math.max(1, Math.min(4, Number(depth) || 2));
  const ignore = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build', '.next', '.cache']);
  const lines = [];
  let count = 0;

  function walk(current, prefix, level) {
    if (count > 400) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      lines.push(`${prefix}[ошибка: ${error.message}]`);
      return;
    }
    entries
      .filter((entry) => !entry.name.startsWith('.DS_Store'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .forEach((entry) => {
        if (count > 400) return;
        count += 1;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          const skipped = ignore.has(entry.name);
          lines.push(`${prefix}${entry.name}/${skipped ? '  (скрыто)' : ''}`);
          if (!skipped && level < maxDepth) walk(full, `${prefix}  `, level + 1);
        } else {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            /* ignore */
          }
          lines.push(`${prefix}${entry.name}  ${humanSize(size)}`);
        }
      });
  }

  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { error: `${target} — не папка` };
    walk(target, '', 1);
    const header = `Папка: ${target}\n${lines.join('\n')}`;
    return { content: count > 400 ? `${header}\n… (список обрезан, всего >400 записей)` : header };
  } catch (error) {
    return { error: `Не удалось прочитать папку ${target}: ${error.message}` };
  }
}

module.exports = { readFileTool, writeFileTool, editFileTool, listDirTool };
