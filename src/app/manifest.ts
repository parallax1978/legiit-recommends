import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Legiit Recommends",
    short_name: "Recommends",
    description: "Repeatable AI conversation campaigns with independent fresh-check measurement.",
    start_url: "/overview",
    display: "standalone",
    background_color: "#f7f7fb",
    theme_color: "#8a12dc",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
