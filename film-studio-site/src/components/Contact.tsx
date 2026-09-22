"use client";

import Link from "next/link";
import { useState } from "react";
import { site } from "@/content/site";
import Section from "./Section";

const projectTypes = ["Реклама", "Клип", "Короткий метр", "Документальное", "Другое"];
const budgets = ["до 300 тыс.", "300–800 тыс.", "800 тыс. – 2 млн", "больше 2 млн", "пока не знаю"];

type Status = "idle" | "sending" | "sent" | "error";

export default function Contact() {
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    // Без настроенного endpoint статический сайт не может отправить письмо сам —
    // открываем почтовый клиент с уже заполненным письмом.
    if (!site.formEndpoint) {
      const body = [
        `Имя: ${data.name ?? ""}`,
        `Контакт: ${data.contact ?? ""}`,
        `Тип проекта: ${data.type ?? ""}`,
        `Бюджет: ${data.budget ?? ""}`,
        "",
        String(data.message ?? ""),
      ].join("\n");
      window.location.href = `mailto:${site.email}?subject=${encodeURIComponent(
        `Заявка с сайта · ${data.name ?? ""}`,
      )}&body=${encodeURIComponent(body)}`;
      setStatus("sent");
      return;
    }

    setStatus("sending");
    try {
      const response = await fetch(site.formEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      form.reset();
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  const fieldClass =
    "w-full rounded-md border border-line bg-bg-soft px-4 py-3 text-sm outline-none transition focus:border-accent";

  return (
    <Section
      id="contact"
      eyebrow="Контакты"
      title="Расскажите о проекте"
      lead="Ответим в течение рабочего дня: обсудим задачу, сроки и бюджет, предложим решение."
    >
      <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-8">
          <div>
            <p className="eyebrow mb-3">Напрямую</p>
            <a
              href={`mailto:${site.email}`}
              className="display block text-2xl transition hover:text-accent sm:text-3xl"
            >
              {site.email}
            </a>
            <a
              href={`tel:${site.phone.replace(/[^+\d]/g, "")}`}
              className="display mt-2 block text-2xl transition hover:text-accent sm:text-3xl"
            >
              {site.phone}
            </a>
          </div>

          <div>
            <p className="eyebrow mb-3">Студия</p>
            <p className="text-muted">
              {site.city}, {site.address}
            </p>
          </div>

          <div>
            <p className="eyebrow mb-3">Соцсети</p>
            <ul className="flex flex-wrap gap-3">
              {site.socials.map((social) => (
                <li key={social.href}>
                  <a
                    href={social.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex rounded-full border border-line px-4 py-2 text-sm text-muted transition hover:border-accent hover:text-fg"
                  >
                    {social.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Как вас зовут *</span>
              <input name="name" required className={fieldClass} autoComplete="name" />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Почта или телефон *</span>
              <input name="contact" required className={fieldClass} autoComplete="email" />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Тип проекта</span>
              <select name="type" className={fieldClass} defaultValue={projectTypes[0]}>
                {projectTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Бюджет</span>
              <select name="budget" className={fieldClass} defaultValue={budgets[0]}>
                {budgets.map((budget) => (
                  <option key={budget} value={budget}>
                    {budget}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-2 block text-sm text-muted">О задаче</span>
            <textarea name="message" rows={5} className={fieldClass} />
          </label>

          <label className="flex items-start gap-3 text-xs text-muted">
            <input type="checkbox" required className="mt-0.5 accent-[var(--accent)]" />
            <span>
              Согласен на обработку персональных данных и принимаю{" "}
              <Link href="/privacy/" className="underline transition hover:text-fg">
                политику конфиденциальности
              </Link>
              .
            </span>
          </label>

          <button
            type="submit"
            disabled={status === "sending"}
            className="inline-flex rounded-full bg-accent px-6 py-3 text-sm font-medium text-black transition hover:bg-accent/85 disabled:opacity-60"
          >
            {status === "sending" ? "Отправляем…" : "Отправить заявку"}
          </button>

          <p aria-live="polite" className="min-h-5 text-sm">
            {status === "sent" && (
              <span className="text-accent">
                {site.formEndpoint
                  ? "Заявка отправлена. Свяжемся с вами в ближайшее время."
                  : "Открыли письмо в вашем почтовом клиенте — осталось нажать «Отправить»."}
              </span>
            )}
            {status === "error" && (
              <span className="text-red-400">
                Не удалось отправить. Напишите нам напрямую: {site.email}
              </span>
            )}
          </p>
        </form>
      </div>
    </Section>
  );
}
