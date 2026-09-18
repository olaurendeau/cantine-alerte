import type { ReactNode } from "react";
import type { Resume } from "./resume.ts";

/**
 * Le glyphe qui porte le verdict.
 *
 * Un point de couleur seul ne dit rien a qui ne distingue pas le rouge du vert,
 * ni a un lecteur d'ecran — meme raisonnement que les emojis d'objet des mails.
 * La couleur ne fait ici que renforcer un signe qui se suffit deja.
 */
const GLYPHE: Record<Resume["ton"], string> = {
  ok: "✓",
  attention: "⚠",
  neutre: "",
};

/**
 * Une section de reglages repliable.
 *
 * `<details>` natif : pas de JavaScript, donc l'etat plie/deplie survit a un
 * rendu serveur et le clavier le pilote sans qu'on ait rien a ecrire. Le resume
 * reste visible ferme — c'est lui qui rend le repli honnete, en disant ce que
 * la section contient au lieu de le cacher.
 */
export function Section({
  titre,
  resume,
  ouvert = false,
  children,
}: {
  titre: string;
  resume: Resume;
  ouvert?: boolean;
  children: ReactNode;
}) {
  const glyphe = GLYPHE[resume.ton];
  return (
    <details className="carte pliable" open={ouvert}>
      <summary>
        <h2>{titre}</h2>
        <span className={`etat ${resume.ton}`}>
          {glyphe && <span aria-hidden="true">{glyphe} </span>}
          {resume.texte}
        </span>
      </summary>
      <div className="corps">{children}</div>
    </details>
  );
}
