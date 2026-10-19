// polish.js —— 朗读稿净化。
//
// 作用：把「写给人看」的 Markdown 回答，改成「念出来不别扭」的口语稿。
// 纯规则实现：零依赖、确定性、毫秒级，不需要联网也不需要额外模型。
//
// 规则顺序有讲究——先砍掉不该读的结构（代码块、表格、URL），
// 再修补该读的部分（路径、数字、列表、长句），最后统一空白。

const CN_DIGITS = "零一二三四五六七八九";

// 书面词 → 口语词。
// 原则：只收「换了不会改意思」的；「该 / 其 / 即 / 且」这类一刀切会误伤（应该、其中、即使），
// 所以只按固定后缀换。长词排前面，避免被短词先咬掉一半。
const COLLOQUIAL = [
  [/综上所述/g, "总的来说"],
  [/总而言之/g, "总之"],
  [/与此同时/g, "同时"],
  [/值得注意的是/g, "要留意的是"],
  [/需要注意的是/g, "要注意"],
  [/需要指出的是/g, "要说的是"],
  [/显而易见/g, "很明显"],
  [/换言之/g, "换个说法"],
  [/也就是说/g, "就是说"],
  [/因此/g, "所以"],
  [/然而/g, "但是"],
  [/此外/g, "另外"],
  [/由于/g, "因为"],
  [/基于/g, "根据"],
  [/从而/g, "这样就能"],
  [/旨在/g, "是为了"],
  [/予以/g, "给"],
  [/具备/g, "有"],
  [/具有/g, "有"],
  [/较为/g, "比较"],
  [/显著/g, "明显"],
  [/诸多/g, "很多"],
  [/各类/g, "各种"],
  [/目前/g, "现在"],
  [/此前/g, "之前"],
  [/随后/g, "然后"],
  [/进而/g, "然后"],
  [/是否/g, "是不是"],
  [/以及/g, "和"],
  [/能够/g, "能"],
  [/尽可能/g, "尽量"],
  [/即可/g, "就能"],
  [/仍需/g, "还得"],
  [/考量/g, "考虑"],
  [/并且/g, "而且"],
  [/例如/g, "比如"],
  [/诸如/g, "像"],
  [/上述/g, "上面说的"],
  [/下列/g, "下面这些"],
  [/进行(?=分析|验证|测试|优化|改造|处理|对比|评估|检查|调整|确认|尝试|推理)/g, "做"],
  [/进行了/g, "做了"],
  [/进行一次/g, "做一次"],
  [/实现了/g, "做到了"],
  [/若(?![干])/g, "如果"],
  [/该(?=方案|方法|文件|功能|问题|工具|插件|模型|配置|做法|操作|字段|参数|版本|接口|服务|流程|设置|选项|目录|进程)/g, "这个"],
];

function colloquialize(text) {
  for (const [pattern, replacement] of COLLOQUIAL) text = text.replace(pattern, replacement);
  // 换完可能出现「所以，所以」这种叠字，收敛一下
  return text.replace(/(所以|但是|因为)，?\1/g, "$1");
}

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
    text = colloquialize(text);
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
