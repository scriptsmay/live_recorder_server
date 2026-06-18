function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(str) {
  return escapeHtml(str)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * 将简化的 Markdown 字符串渲染为 HTML 字符串。
 * 支持代码块、表格、标题（h2-h4）、水平线、列表项和段落。
 *
 * @param {string} md - 输入的 Markdown 文本。
 * @returns {string} 渲染后的 HTML 字符串。
 */
function render(md) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let tableBuf = null;

  /**
   * 将当前缓冲的表格数据转换为 HTML 表格结构并追加到输出数组中。
   * 如果当前没有正在构建的表格，则直接返回。
   */
  function flushTable() {
    if (!tableBuf) return;
    const [header, ...rows] = tableBuf;
    out.push('<div class="table-responsive"><table class="table table-bordered">');
    out.push('<thead><tr>');
    for (const cell of header) {
      out.push(`<th>${inline(cell)}</th>`);
    }
    out.push('</tr></thead><tbody>');
    for (const row of rows) {
      out.push('<tr>');
      for (const cell of row) {
        out.push(`<td>${inline(cell)}</td>`);
      }
      out.push('</tr>');
    }
    out.push('</tbody></table></div>');
    tableBuf = null;
  }

  /**
   * 尝试将一行文本解析为表格行。
   * 如果该行符合表格行格式（以 '|' 开头和结尾，且包含至少两个单元格），则返回单元格数组；否则返回 null。
   *
   * @param {string} line - 待解析的行文本。
   * @returns {string[] | null} 单元格数组或 null。
   */
  function tryParseRow(line) {
    if (!line.startsWith('|') || !line.endsWith('|')) return null;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) return null;
    return cells;
  }

  // 逐行处理 Markdown 内容
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 处理代码块的开始和结束标记
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        codeLang = '';
        inCode = false;
      } else {
        flushTable();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    // 如果处于代码块内部，将当前行加入代码缓冲区
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // 尝试解析表格行
    const row = tryParseRow(line);
    if (row) {
      if (!tableBuf) {
        tableBuf = [];
      }
      const isSep = row.every((c) => /^[-:]+$/.test(c));
      if (!isSep) {
        tableBuf.push(row);
      }
      continue;
    }

    // 遇到非表格行时，先输出之前积累的表格
    flushTable();

    // 处理标题、水平线、列表项和普通段落
    if (line.startsWith('# ')) {
      out.push(`<h2 class="mb-3">${inline(line.slice(2))}</h2>`);
    } else if (line.startsWith('## ')) {
      out.push(`<h3 class="mt-4 mb-2">${inline(line.slice(3))}</h3>`);
    } else if (line.startsWith('### ')) {
      out.push(`<h4 class="mt-3 mb-2">${inline(line.slice(4))}</h4>`);
    } else if (line.startsWith('---')) {
      out.push('<hr class="my-4" />');
    } else if (line.startsWith('- ')) {
      out.push(`<p class="mb-1">${inline(line.slice(2))}</p>`);
    } else if (line === '') {
      out.push('');
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }

  // 确保文件末尾的表格也被正确输出
  flushTable();

  return out.join('\n');
}

module.exports = { render };
