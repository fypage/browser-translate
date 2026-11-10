/* 真实译文：由必应翻译接口生成，非手写 */
window.DEMO_DATA = [
  {en:"Why we rebuilt our translation pipeline from scratch", zh:"为什么我们从头重建了我们的翻译流程"},
  {en:"For three years, we relied on a commercial machine translation API. It was fast, cheap, and completely wrong about our product.", zh:"三年来，我们依赖商业机器翻译 API。它快速、廉价，但对我们的产品完全错误。"},
  {en:"The problem was not accuracy in the usual sense. The words were translated. The meaning was not. Our feature \"snapshot\" became a photograph of the interface, our \"workspace\" became a factory floor, and our \"token\" became a subway ticket.", zh:"问题不在于通常意义上的准确性。单词被翻译了，但意思没有。我们的功能“快照”变成了界面的照片，我们的“工作区”变成了工厂车间，而我们的“令牌”变成了地铁票。"},
  {en:"We tried adding a glossary. It helped, but only for the words we already knew were wrong. The failures we cared about were the ones we had not noticed yet.", zh:"我们尝试添加了一个词汇表。这有所帮助，但只对我们已经知道错误的词有效。我们关心的失败是那些我们尚未发现的错误。"},
  {en:"So we started over, with a different assumption: translation is not a lookup, it is a rewriting task. It needs context, consistency, and someone who understands what the text is for.", zh:"所以我们重新开始，带着一个不同的假设：翻译不是查找，它是一个改写任务。它需要上下文、一致性，以及理解文本用途的人。"},
  {en:"The new pipeline sends the page title, the surrounding paragraphs, and a domain glossary to a language model in a single batch, then asks for structured output.", zh:"新的管道将页面标题、周围的段落和域名词表作为一个批次发送给语言模型，然后请求结构化输出。"},
  {en:"The result is not perfect. It is simply good enough that our readers stopped filing tickets about it, which is the highest praise a translation system can receive.", zh:"结果并不完美。它只是好到足以让我们的读者不再提交相关问题，这是翻译系统能得到的最高赞誉。"},
];
