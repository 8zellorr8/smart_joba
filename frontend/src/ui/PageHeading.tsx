export function PageHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading page-heading--document">
      <p className="eyebrow">{eyebrow}</p>
      <h1 id={id}>{title}</h1>
      <p className="page-description">{description}</p>
    </div>
  );
}
