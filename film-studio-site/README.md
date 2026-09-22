# Сайт-визитка творческого объединения

Одностраничный сайт кинопродакшна с отдельными страницами проектов.
Next.js 16 (App Router) + Tailwind CSS 4, собирается в статику и раздаётся
Cloudflare Pages — без сервера, без воркеров, бесплатно.

## Что внутри

- главный экран с шоурилом в модальном окне (YouTube/Vimeo);
- портфолио с фильтром по типу проекта и отдельной страницей под каждый проект;
- услуги, этапы работы, команда, бегущая строка клиентов;
- форма заявки (Formspree/Getform/свой воркер или fallback на почтовый клиент);
- SEO: метатеги, Open Graph, JSON-LD (Organization), `sitemap.xml`, `robots.txt`;
- тёмная кинематографичная тема, адаптив, поддержка `prefers-reduced-motion`.

## Быстрый старт

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # статика в ./out
npm run lint
```

## Как наполнить сайт

Весь контент лежит в одном файле — [`src/content/site.ts`](src/content/site.ts).
Там же помечены плейсхолдеры комментарием `// TODO`. Менять нужно:

| Что | Где |
| --- | --- |
| Название, слоган, описание | `site.name`, `site.tagline`, `site.heroTitle` |
| Контакты и соцсети | `site.email`, `site.phone`, `site.city`, `site.socials` |
| Шоурил | `site.showreelUrl` — **embed-ссылка** (`https://www.youtube.com/embed/ID`) |
| Видео-фон главного экрана | `site.heroVideo` — путь к mp4 в `public/` (пусто → статичный постер) |
| Проекты | массив `projects` |
| Услуги, этапы, команда, клиенты | `services`, `processSteps`, `team`, `clients` |
| Цифры под главным экраном | `stats` |

Картинки кладите в `public/`: постеры проектов — `public/posters/`,
фото команды — любой путь внутри `public/`, он же указывается в `photo`.
Сейчас в `public/posters/` лежат SVG-заглушки — замените их на настоящие кадры
(рекомендуемый размер 1600×900, jpg или webp).

Фирменные цвета и шрифты — в `src/app/globals.css` (переменные `--accent`,
`--bg`, `--fg`) и в `src/app/layout.tsx` (`Inter` + `Oswald`).

## Переменные окружения

Скопируйте `.env.example` в `.env.local` для локальной разработки и задайте те же
переменные в настройках Cloudflare Pages:

- `NEXT_PUBLIC_SITE_URL` — боевой домен, используется в canonical, OG и sitemap;
- `NEXT_PUBLIC_FORM_ENDPOINT` — URL приёма заявок (Formspree, Getform, Web3Forms,
  собственный Cloudflare Worker). Если не задан, форма откроет почтовый клиент
  с уже заполненным письмом — сайт остаётся рабочим, но заявки приходят вручную.

## Деплой на Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, выбрать этот репозиторий.
2. Настройки сборки:
   - Framework preset: **Next.js (Static HTML Export)** (или **None**);
   - Build command: `npm run build`;
   - Build output directory: `out`;
   - Node version: `22` (переменная `NODE_VERSION=22`).
3. В **Settings → Environment variables** добавить `NEXT_PUBLIC_SITE_URL`
   и, если нужен приём заявок, `NEXT_PUBLIC_FORM_ENDPOINT`.
4. Деплой. Дальше каждый пуш в основную ветку собирается автоматически,
   пуш в другую ветку даёт preview-ссылку.

Свой домен подключается в **Custom domains** — если домен уже в Cloudflare,
DNS-запись создаётся автоматически.

Заголовки кеширования и безопасности лежат в [`public/_headers`](public/_headers) —
Cloudflare Pages применяет их сам, править конфиг не нужно.

## Структура

```
src/
  app/
    layout.tsx           общий каркас, шрифты, метатеги
    page.tsx             главная страница
    works/[slug]/        страницы проектов (генерируются из projects)
    privacy/             политика конфиденциальности (ТРЕБУЕТ ПРАВКИ ЮРИСТА)
    sitemap.ts robots.ts
  components/            секции главной и переиспользуемые блоки
  content/site.ts        ВЕСЬ контент сайта
public/posters/          постеры проектов (сейчас — заглушки)
```
