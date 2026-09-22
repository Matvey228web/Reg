import { processSteps } from "@/content/site";
import Reveal from "./Reveal";
import Section from "./Section";

export default function Process() {
  return (
    <Section
      id="about"
      eyebrow="Как работаем"
      title="Процесс"
      lead="Прозрачные этапы: на каждом вы понимаете, что происходит, сколько это стоит и когда закончится."
    >
      <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {processSteps.map((step, i) => (
          <Reveal key={step.step} delay={i * 80}>
            <li className="h-full border-t border-accent/50 pt-5">
              <span className="display block text-4xl text-accent">{step.step}</span>
              <h3 className="mt-3 text-lg font-medium">{step.title}</h3>
              <p className="mt-2 text-sm text-muted">{step.text}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}
