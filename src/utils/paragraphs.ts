/**
 * 段落 / 光标定位（专注模式镜像层使用，审查 UX-1）。
 *
 * 段落只按换行符 \n 划分——高亮的是「当前段落」，不是浏览器自动折出的视觉行。
 * 长中文一段内自动换行不会产生新段落，因此不会出现「点第二行却高亮第一行」的错位。
 */
export interface ActiveParagraph {
  /** 按 \n 切出的全部段落 */
  paras: string[];
  /** 光标所在段落下标 */
  activeIdx: number;
  /** 光标在当前段落内的字符偏移 */
  caretOff: number;
}

export function splitActiveParagraph(content: string, caret: number): ActiveParagraph {
  const paras = content.split('\n');
  let acc = 0;
  let activeIdx = paras.length - 1;
  let caretOff = paras[paras.length - 1]?.length ?? 0;
  for (let i = 0; i < paras.length; i++) {
    const start = acc;
    const end = acc + paras[i].length;
    if (caret >= start && caret <= end) {
      activeIdx = i;
      caretOff = caret - start;
      break;
    }
    acc = end + 1; // +1 为换行符
  }
  return { paras, activeIdx, caretOff };
}
