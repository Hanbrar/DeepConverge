// Convert \[...\] → $$...$$ and \(...\) → $...$ so remark-math can parse them
export function preprocessLaTeX(content: string): string {
  // Replace display math \[...\] with $$...$$
  content = content.replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner) => `$$${inner}$$`);
  // Replace inline math \(...\) with $...$
  content = content.replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => `$${inner}$`);
  return content;
}
