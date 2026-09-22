import Image from "next/image";
import { team } from "@/content/site";
import Reveal from "./Reveal";
import Section from "./Section";

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("");
}

export default function Team() {
  return (
    <Section
      id="team"
      eyebrow="Команда"
      title="Кто снимает"
      lead="Постоянное ядро объединения. На проект собираем расширенную группу под задачу."
    >
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {team.map((member, i) => (
          <Reveal key={member.name + i} delay={(i % 4) * 70}>
            <article className="h-full overflow-hidden rounded-lg border border-line bg-surface">
              <div className="relative aspect-[4/5] bg-bg-soft">
                {member.photo ? (
                  <Image
                    src={member.photo}
                    alt={member.name}
                    fill
                    sizes="(max-width: 640px) 100vw, 25vw"
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <span className="display text-5xl text-line">{initials(member.name)}</span>
                  </div>
                )}
              </div>
              <div className="p-5">
                <h3 className="text-lg font-medium">{member.name}</h3>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-accent">
                  {member.role}
                </p>
                <p className="mt-3 text-sm text-muted">{member.bio}</p>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
