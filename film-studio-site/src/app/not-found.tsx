import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70svh] w-full max-w-3xl flex-col justify-center px-4 py-32 sm:px-6">
      <p className="eyebrow mb-4">Ошибка 404</p>
      <h1 className="display text-5xl sm:text-6xl">Кадр не найден</h1>
      <p className="mt-5 text-muted">
        Такой страницы нет — возможно, проект переехал или ссылка устарела.
      </p>
      <Link
        href="/"
        className="mt-10 inline-flex w-fit rounded-full bg-accent px-6 py-3 text-sm font-medium text-black transition hover:bg-accent/85"
      >
        На главную
      </Link>
    </div>
  );
}
