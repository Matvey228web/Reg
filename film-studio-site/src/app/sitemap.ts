import type { MetadataRoute } from "next";
import { projects, site } from "@/content/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    { url: `${site.url}/`, lastModified: now, priority: 1 },
    { url: `${site.url}/privacy/`, lastModified: now, priority: 0.3 },
    ...projects.map((project) => ({
      url: `${site.url}/works/${project.slug}/`,
      lastModified: now,
      priority: 0.8,
    })),
  ];
}
