import { redirect } from "next/navigation";
import { sessionCourante } from "../lib/auth/session.ts";

export default async function Accueil() {
  redirect((await sessionCourante()) ? "/reglages" : "/connexion");
}
