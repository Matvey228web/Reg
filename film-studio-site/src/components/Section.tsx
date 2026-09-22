type Props = {
  id?: string;
  eyebrow?: string;
  title?: string;
  lead?: string;
  children: React.ReactNode;
  className?: string;
};

export default function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className = "",
}: Props) {
  return (
    <section id={id} className={`border-t border-line/60 py-20 sm:py-28 ${className}`}>
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {(eyebrow || title || lead) && (
          <header className="mb-12 max-w-3xl">
            {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
            {title && (
              <h2 className="display text-4xl sm:text-5xl lg:text-6xl">{title}</h2>
            )}
            {lead && <p className="mt-5 text-lg text-muted">{lead}</p>}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}
