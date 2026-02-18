import type { Article, UserPosition } from "./types";

/** Mock position: near the Eiffel Tower, Paris */
export const mockPosition: UserPosition = {
  lat: 48.8584,
  lon: 2.2945,
};

/** Real Paris landmarks with approximate coordinates. */
export const mockArticles: Article[] = [
  { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945 },
  { title: "Champ de Mars", lat: 48.856, lon: 2.2983 },
  { title: "Palais de Chaillot", lat: 48.8627, lon: 2.2876 },
  { title: "Pont d'Iéna", lat: 48.8608, lon: 2.2935 },
  { title: "Musée du quai Branly", lat: 48.8611, lon: 2.2978 },
  { title: "Les Invalides", lat: 48.8567, lon: 2.3125 },
  { title: "Pont de l'Alma", lat: 48.8642, lon: 2.3008 },
  { title: "Palais de Tokyo", lat: 48.8641, lon: 2.2967 },
  { title: "Arc de Triomphe", lat: 48.8738, lon: 2.295 },
  { title: "Trocadéro Gardens", lat: 48.8622, lon: 2.2887 },
];
