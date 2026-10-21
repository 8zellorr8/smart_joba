/** Presentation aliases for the prepared demo only; never rewrite source data. */
const names: Record<string, string> = {
  "DEMO-GROUP": "Демо топ 100-А",
  "TEST-EDITOR-A": "Демо топ 101-А",
  "TEST-EDITOR-B": "Демо топ 101-Б",
  "TEST-IMPORT-A": "Демо топ · импорт үлгісі",
  "SYNTHETIC Editor Teacher A": "Демо оқытушы А",
  "SYNTHETIC Editor Teacher B": "Демо оқытушы Б",
  "Синтетикалық мұғалім": "Демо оқытушы · импорт үлгісі",
  "Демо оқытушы · синтетикалық дерек": "Демо оқытушы",
  "SYNTHETIC Subject 0": "Ағылшын тілі · демо",
  "SYNTHETIC Subject 1": "Қазақ тілі · демо",
  "SYNTHETIC Subject 2": "Информатика · демо",
  "TEST-EDITOR-0": "Демо жүктеме №1",
  "TEST-EDITOR-1": "Демо жүктеме №2",
  "TEST-EDITOR-2": "Демо жүктеме №3",
  "TEST-101": "Демо кабинет 101",
  "TEST-102": "Демо кабинет 102",
  "SYNTHETIC TEST editor draft": "Демо оқу кестесі",
  "TEST theory": "Теориялық оқу · демо",
  "SYNTHETIC TEST theory": "Теориялық оқу · демо",
  "TEST vacation": "Демалыс · демо",
  "SYNTHETIC TEST vacation": "Демалыс · демо",
  "TEST 90 minutes": "1-сабақ (90 минут)",
  "TEST next": "2-сабақ (90 минут)",
};

const files: Record<string, string> = {
  "synthetic.xlsx": "Демо оқу жүктемесі.xlsx",
  "synthetic-s1-demo.xlsx": "Демо импорт үлгісі.xlsx",
  "synthetic-s1-updated.xlsx": "Демо импорт үлгісі · жаңартылған.xlsx",
};

export function demoName(value: string | number, dataKind?: string): string {
  const text = String(value);
  if (dataKind !== "synthetic") return text;
  if (Object.hasOwn(names, text)) return names[text];
  // Keep the distinguishing suffix of earlier import smoke samples.
  const sample = /^TEST-IMPORT-([a-f0-9]{8})$/.exec(text);
  if (sample) return `Демо импорт тобы · үлгі ${sample[1]}`;
  const generated = /^Автоматты жоба · (\d+) · ([a-f0-9]{8})$/.exec(text);
  if (generated)
    return `Демо кесте · ${generated[1]}-семестр · ${generated[2]}`;
  return text;
}

export function demoFileName(filename: string, dataKind?: string): string {
  return dataKind === "synthetic" && Object.hasOwn(files, filename)
    ? files[filename]
    : filename;
}
