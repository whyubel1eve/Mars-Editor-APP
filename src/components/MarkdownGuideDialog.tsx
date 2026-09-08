import { BookOpenText, X } from '@phosphor-icons/react';

interface Props { open: boolean; onClose: () => void; }

const examples = [
  ['标题', '# 一级标题\n## 二级标题'],
  ['强调', '**加粗**、*斜体*、~~删除线~~'],
  ['链接与图片', '[链接文字](https://example.com)\n![图片说明](图片路径)'],
  ['列表', '- 项目一\n- 项目二\n  - 子项目'],
  ['引用', '> 这是一段引用\n> 可以有多行'],
  ['代码', '`行内代码`\n```\n代码块\n```'],
  ['表格', '| 项目 | 说明 |\n| --- | --- |\n| 标题 | 内容 |'],
];

export default function MarkdownGuideDialog({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal markdown-guide" role="dialog" aria-modal="true" aria-label="Markdown 语法说明" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <BookOpenText size={18} weight="duotone" />
          <h2>Markdown 语法说明</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭"><X size={15} weight="bold" /></button>
        </header>
        <div className="modal-body markdown-guide-body">
          <p className="form-note">用简单的纯文本标记组织文章，写完即可在右侧查看公众号排版效果。</p>
          <div className="markdown-guide-grid">
            {examples.map(([name, syntax]) => (
              <section className="markdown-example" key={name}>
                <h3>{name}</h3>
                <pre>{syntax}</pre>
              </section>
            ))}
          </div>
          <section className="markdown-guide-tips">
            <h3>公众号写作提示</h3>
            <ul>
              <li>标题使用一级或二级标题，预览会自动套用当前主题。</li>
              <li>图片建议使用本地文件并拖入工作区，发布前会检查图片是否可上传。</li>
              <li>完成后可点「复制正文」粘贴到公众号，或点「推草稿」发送到草稿箱。</li>
            </ul>
          </section>
        </div>
        <footer className="modal-foot"><button className="btn primary" onClick={onClose}>知道了</button></footer>
      </div>
    </div>
  );
}
