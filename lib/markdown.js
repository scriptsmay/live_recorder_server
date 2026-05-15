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

function render(md) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let tableBuf = null;

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

  function tryParseRow(line) {
    if (!line.startsWith('|') || !line.endsWith('|')) return null;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) return null;
    return cells;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

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

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

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

    flushTable();

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

  flushTable();

  return out.join('\n');
}

module.exports = { render };
