import { clients } from "@/content/site";

export default function Clients() {
  const row = [...clients, ...clients];

  return (
    <section
      className="overflow-hidden border-t border-line/60 py-10"
      aria-label="С кем работали"
    >
      <div className="flex w-max marquee gap-12 px-6">
        {row.map((client, i) => (
          <span
            key={`${client}-${i}`}
            className="display whitespace-nowrap text-2xl text-line sm:text-3xl"
            aria-hidden={i >= clients.length}
          >
            {client}
          </span>
        ))}
      </div>
    </section>
  );
}
