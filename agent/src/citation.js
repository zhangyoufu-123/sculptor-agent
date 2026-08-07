// 参考文献格式化（确定性，零 LLM）：GB/T 7714-2015（中文学术默认）与 APA 7。
// 覆盖期刊/图书/网页/报纸/学位论文/报告六类；条目字段见 parseEntries。
import fs from 'node:fs';

const TYPE_LABEL = {
  journal: 'J',
  book: 'M',
  web: 'EB/OL',
  newspaper: 'N',
  thesis: 'D',
  report: 'R',
};

function authorsList(authors, { max = 3 } = {}) {
  const list = (authors || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')}, 等`;
}

function apaAuthors(authors, { max = 20 } = {}) {
  const list = (authors || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max - 1).join(', ')}, ... ${list[list.length - 1]}`;
}

function gbt7714(entry) {
  const auRaw = authorsList(entry.authors);
  const au = auRaw ? `${auRaw}. ` : '';
  const year = entry.year ? String(entry.year) : '';
  const t = entry.title || '';
  switch (entry.type) {
    case 'journal':
      return `${au}${t}[J]. ${entry.journal || ''}, ${year}${entry.volume ? `, ${entry.volume}` : ''}${entry.issue ? `(${entry.issue})` : ''}${entry.pages ? `: ${entry.pages}` : ''}.`.replace(/\s+/g, ' ').trim();
    case 'book':
      return `${au}${t}[M]. ${entry.edition ? `${entry.edition}. ` : ''}${entry.city ? `${entry.city}: ` : ''}${entry.publisher || ''}, ${year}${entry.pages ? `: ${entry.pages}` : ''}.`.replace(/\s+/g, ' ').trim();
    case 'web':
      return `${au}${t}[EB/OL]. ${entry.site ? `${entry.site}, ` : ''}${year ? `${year}` : ''}${entry.accessDate ? `[${entry.accessDate}]` : ''}. ${entry.url || ''}.`.replace(/\s+/g, ' ').trim();
    case 'newspaper':
      return `${au}${t}[N]. ${entry.newspaper || ''}, ${entry.date || year}${entry.page ? `(${entry.page})` : ''}.`.replace(/\s+/g, ' ').trim();
    case 'thesis':
      return `${au}${t}[D]. ${entry.city ? `${entry.city}: ` : ''}${entry.school || ''}, ${year}.`.replace(/\s+/g, ' ').trim();
    case 'report':
      return `${au}${t}[R]. ${entry.city ? `${entry.city}: ` : ''}${entry.institution || ''}, ${year}.`.replace(/\s+/g, ' ').trim();
    default:
      return `${au}${t}[${TYPE_LABEL[entry.type] || 'Z'}]. ${year}.`.replace(/\s+/g, ' ').trim();
  }
}

function apa7(entry) {
  const au = apaAuthors(entry.authors);
  const year = entry.year ? String(entry.year) : 'n.d.';
  const t = entry.title || '';
  switch (entry.type) {
    case 'journal':
      return `${au} (${year}). ${t}. ${entry.journal || ''}, ${entry.volume || ''}${entry.issue ? `(${entry.issue})` : ''}${entry.pages ? `, ${entry.pages}` : ''}.${entry.doi ? ` https://doi.org/${entry.doi}` : ''}`.replace(/\s+/g, ' ').trim();
    case 'book':
      return `${au} (${year}). ${t}. ${entry.publisher || ''}.`.replace(/\s+/g, ' ').trim();
    case 'web':
      return `${au} (${year}). ${t}. ${entry.site || ''}. ${entry.url || ''}`.replace(/\s+/g, ' ').trim();
    case 'newspaper':
      return `${au} (${entry.date || year}). ${t}. ${entry.newspaper || ''}${entry.page ? `, p. ${entry.page}` : ''}.`.replace(/\s+/g, ' ').trim();
    case 'thesis':
      return `${au} (${year}). ${t} [${entry.school || '学位论文'}].`.replace(/\s+/g, ' ').trim();
    case 'report':
      return `${au} (${year}). ${t} [Report]. ${entry.institution || ''}.`.replace(/\s+/g, ' ').trim();
    default:
      return `${au} (${year}). ${t}.`.replace(/\s+/g, ' ').trim();
  }
}

/** 格式化单条参考文献。entry 示例：{type:'journal',authors:['史铁生'],year:2024,title:'...',journal:'...',volume:3,issue:2,pages:'1-10',doi:'10.x'} */
export function formatReference(entry, style = 'gbt7714') {
  if (!entry || typeof entry !== 'object') return '';
  const s = style === 'apa' ? apa7(entry) : gbt7714(entry);
  return s.replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/^[，,]\s*/, '').trim();
}

/** 批量格式化。 */
export function formatReferences(entries, style = 'gbt7714') {
  return (entries || []).filter(Boolean).map((e, i) => `${i + 1}. ${formatReference(e, style)}`);
}

/** 解析条目：接受 JSON 字符串、JSON 数组或对象数组。 */
export function parseEntries(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return [input];
  const parsed = JSON.parse(String(input).trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** 从 JSON 文件读条目。 */
export function readEntriesFile(file) {
  return parseEntries(fs.readFileSync(file, 'utf8'));
}

export function citationStyles() {
  return ['gbt7714', 'apa'];
}
