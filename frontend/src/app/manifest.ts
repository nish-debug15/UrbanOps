import type { MetadataRoute } from "next";

/** Makes the web portal installable on phones ("Add to Home screen"), opening on the report form. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "UrbanOps",
    short_name: "UrbanOps",
    description: "Report city infrastructure issues and follow them until they are fixed.",
    start_url: "/report",
    display: "standalone",
    background_color: "#F4F3F0",
    theme_color: "#2B5C5D",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
