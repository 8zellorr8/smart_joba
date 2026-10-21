# Inter, локальный шрифт интерфейса

Оригинальный `InterVariable.woff2` проекта [Inter](https://github.com/rsms/inter),
ревизия `353b61b9f4430d5f420d56605a6e7993e0941470`:
`docs/font-files/InterVariable.woff2`. Файл не изменялся.

- Размер: 352 240 байт.
- SHA-256: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.
- Лицензия SIL Open Font License 1.1 сохранена в
  [`frontend/public/assets/Inter-OFL.txt`](../../../public/assets/Inter-OFL.txt)
  и копируется Vite в сборку как `/assets/Inter-OFL.txt`.
- Официальный парный TTF той же ревизии проверен по cmap: казахские
  `ӘәҒғҚқҢңӨөҰұҮүҺһІі`, русский алфавит с Ё/ё и английские буквы/цифры присутствуют.

Vite включает шрифт в хешированные `/assets/`; preload и CSS используют один
локальный файл. Обращения к Google Fonts/CDN для отображения сайта не нужны.
При недоступном файле сохраняется системная цепочка Segoe UI / Arial / sans-serif.
