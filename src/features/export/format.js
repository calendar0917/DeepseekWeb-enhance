function fmtDateOnly(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeFilePart(text, fallback = 'untitled') {
  const cleaned = String(text || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function exportFileName(results, ext) {
  if (results.length === 1) {
    const session = results[0].session || {};
    return `${safeFilePart(session.title || session.id)}-${fmtDateOnly(session.updated_at)}.${ext}`;
  }
  const date = new Date().toISOString().slice(0, 10);
  return `dse-export-${results.length}-sessions-${date}.${ext}`;
}

function messageRoleLabel(role) {
  if (role === 'USER') return '用户';
  if (role === 'ASSISTANT') return '助手';
  return role || '消息';
}

function renderMarkdownMessageTree(messages) {
  const nodes = messages.map((message, index) => ({ message, index, children: [] }));
  const byId = new Map(nodes.map(node => [node.message.message_id, node]));
  const roots = [];
  nodes.forEach(node => {
    const parent = node.message.parent_id ? byId.get(node.message.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  const lines = [];
  const walk = (node, depth) => {
    const heading = '#'.repeat(Math.min(6, depth + 3));
    const branch = depth ? ` 分支层级 ${depth}` : '';
    lines.push(`${heading} ${messageRoleLabel(node.message.role)} #${node.index + 1}${branch}`);
    lines.push('');
    lines.push(node.message.content || '');
    lines.push('');
    node.children.forEach(child => walk(child, depth + 1));
  };
  roots.forEach(root => walk(root, 0));
  return lines.join('\n');
}

module.exports = {
  exportFileName,
  fmtDateOnly,
  renderMarkdownMessageTree,
  safeFilePart,
};
