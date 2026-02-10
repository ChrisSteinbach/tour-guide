import type { Article, UserPosition } from "./types";

/** Mock position: near the Eiffel Tower, Paris */
export const mockPosition: UserPosition = {
  lat: 48.8584,
  lon: 2.2945,
};

/** Real Paris landmarks with approximate coordinates. */
export const mockArticles: Article[] = [
  {
    title: "Eiffel Tower",
    lat: 48.8584,
    lon: 2.2945,
    desc: "Iron lattice tower on the Champ de Mars",
  },
  {
    title: "Champ de Mars",
    lat: 48.856,
    lon: 2.2983,
    desc: "Large public greenspace near the Eiffel Tower",
  },
  {
    title: "Palais de Chaillot",
    lat: 48.8627,
    lon: 2.2876,
    desc: "Palace and museum complex across the Seine",
  },
  {
    title: "Pont d'Iéna",
    lat: 48.8608,
    lon: 2.2935,
    desc: "Bridge spanning the Seine near the Eiffel Tower",
  },
  {
    title: "Musée du quai Branly",
    lat: 48.8611,
    lon: 2.2978,
    desc: "Museum of indigenous art and cultures",
  },
  {
    title: "Les Invalides",
    lat: 48.8567,
    lon: 2.3125,
    desc: "Complex of museums and monuments relating to French military history",
  },
  {
    title: "Pont de l'Alma",
    lat: 48.8642,
    lon: 2.3008,
    desc: "Bridge crossing the Seine, named after the Battle of Alma",
  },
  {
    title: "Palais de Tokyo",
    lat: 48.8641,
    lon: 2.2967,
    desc: "Modern art museum on the Right Bank",
  },
  {
    title: "Arc de Triomphe",
    lat: 48.8738,
    lon: 2.295,
    desc: "Triumphal arch at the western end of the Champs-Élysées",
  },
  {
    title: "Trocadéro Gardens",
    lat: 48.8622,
    lon: 2.2887,
    desc: "Gardens between the Palais de Chaillot and the Seine",
  },
];
