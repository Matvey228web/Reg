import type { Metadata } from "next";
import { site } from "@/content/site";

export const metadata: Metadata = {
  title: "Политика конфиденциальности",
  description: `Как ${site.legalName} обрабатывает персональные данные, оставленные через форму на сайте.`,
};

// TODO: заменить на текст, согласованный с вашим юристом.
export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-32 sm:px-6 sm:pt-40">
      <h1 className="display text-4xl sm:text-5xl">Политика конфиденциальности</h1>
      <div className="mt-8 space-y-5 text-muted">
        <p>
          {site.legalName} обрабатывает персональные данные, которые вы оставляете
          в форме обратной связи, только для ответа на вашу заявку.
        </p>
        <h2 className="display pt-4 text-2xl text-fg">Какие данные мы собираем</h2>
        <p>
          Имя, контакт для связи (почта или телефон) и текст сообщения — то, что вы
          заполняете сами. Мы не собираем данные автоматически и не передаём их третьим
          лицам, кроме сервиса приёма заявок, указанного в настройках сайта.
        </p>
        <h2 className="display pt-4 text-2xl text-fg">Сколько храним</h2>
        <p>
          До завершения переписки по вашему обращению или до вашего отзыва согласия.
        </p>
        <h2 className="display pt-4 text-2xl text-fg">Как отозвать согласие</h2>
        <p>
          Напишите на{" "}
          <a href={`mailto:${site.email}`} className="text-fg underline">
            {site.email}
          </a>{" "}
          — удалим данные и подтвердим это письмом.
        </p>
      </div>
    </div>
  );
}
