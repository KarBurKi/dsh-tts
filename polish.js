// polish.js —— 朗读稿净化。
//
// 作用：把「写给人看」的 Markdown 回答，改成「念出来不别扭」的口语稿。
// 纯规则实现：零依赖、确定性、毫秒级，不需要联网也不需要额外模型。
//
// 规则顺序有讲究——先砍掉不该读的结构（代码块、表格、URL），
// 再修补该读的部分（路径、数字、列表、长句），最后统一空白。

const CN_DIGITS = "零一二三四五六七八九";

// 长句里这些词前面值得停一下，否则一口气念二十几个字，听着像背课文。
const CONNECTIVES =
  /(?<![，。！？；：、\s])(但是|可是|不过|所以|因此|因为|由于|然后|接着|而且|并且|如果|虽然|即使|另外|此外|同时|最后|首先|其次)/g;

// 年份逐位念：2026 年 -> 二零二六年（直接念「两千零二十六年」会很怪）。
function readYears(text) {
  return text.replace(/(?<!\d)((?:19|20)\d{2})\s*(?=年)/g, (_m, year) =>
    year.split("").map((d) => CN_DIGITS[Number(d)]).join(""),
  );
}

// 50% -> 百分之 50（后面的阿拉伯数字交给 TTS，它念得对）。
function readPercents(text) {
  return text.replace(/(\d+(?:\.\d+)?)\s*[%％]/g, "百分之$1");
}

// 路径只留文件名：C:\Users\x\config.json -> config.json
// 全路径念出来又长又糊，留个文件名反而能听懂「说的是哪个文件」。
function shortenPaths(text) {
  let out = text.replace(
    /[A-Za-z]:[\\/](?:[^\s，。；：、）】"'<>|?*]+[\\/])*([^\s，。；：、）】"'<>|?*]+)/g,
    "$1",
  );
  out = out.replace(/(?<![\w:./])\/(?:[\w.-]+\/)+([\w.-]+)/g, "$1");
  return out;
}

// 列表项单独成句，补个句号，让 TTS 有停顿；不然「甲 乙 丙」会连成一串。
function punctuateListItems(text) {
  return text.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+(.+?)\s*$/gm, (_m, body) => {
    if (/[。！？!?；;，,、：:]$/.test(body)) return body;
    return body + "。";
  });
}

// 超长的一句话，在连接词前插逗号，制造换气点。
function softenLongClauses(text, max = 42) {
  return text.replace(/[^。！？!?；;\n]+/g, (seg) => {
    if (seg.length <= max) return seg;
    return seg.replace(CONNECTIVES, "，$1").replace(/^，/, "");
  });
}

export function toSpeech(markdown, cfg = {}) {
  const polish = cfg.polish === "off" ? "off" : "rules";
  let text = String(markdown || "");

  // 1. 结构性内容：不该进耳朵的
  if (cfg.skipCodeBlocks !== false) text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/<[^>]+>/g, "");

  // 2. 结构标记
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = punctuateListItems(text);
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, "");
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*\|.*\|\s*$/gm, " "); // 表格不读
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, " ");

  // 3. 行内格式
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  text = text.replace(/\*/g, ""); // 落单的星号会被念成「星号」，直接抹掉
  text = text.replace(/\p{Extended_Pictographic}/gu, " "); // emoji 会让上游编码崩溃
  text = text.replace(/[\uFE0F\u200D\u20E3]/g, "");

  // 4. 不该念出来的地址
  text = text.replace(/https?:\/\/\S+/g, " ");

  if (polish === "rules") {
    text = shortenPaths(text);
    text = text.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1"); // 50,000 -> 50000
    text = readYears(text);
    text = readPercents(text);
    text = text.replace(/--+/g, "——");
    text = text.replace(/\.{3,}/g, "……");
    text = text.replace(/[""'']/g, "");
    text = text.replace(/\(/g, "（").replace(/\)/g, "）");
    text = softenLongClauses(text);
  }

  // 5. 收尾
  text = text.replace(/\s+/g, " ").trim();

  if (text.length > cfg.maxChars) {
    const clipped = text.slice(0, cfg.maxChars);
    const cut = Math.max(
      clipped.lastIndexOf("。"),
      clipped.lastIndexOf("！"),
      clipped.lastIndexOf("？"),
      clipped.lastIndexOf("."),
      clipped.lastIndexOf("\n"),
    );
    text = cut > cfg.maxChars * 0.5 ? clipped.slice(0, cut + 1) : clipped;
  }
  return text.trim();
}
