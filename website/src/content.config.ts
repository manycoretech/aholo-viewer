import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const localizedText = z.object({
    'zh-CN': z.string().min(1),
    'en-US': z.string().min(1),
});

const renderSessionRendererOptions = z
    .object({
        antialiasing: z.boolean().default(false),
        pixelRatio: z.number().positive().optional(),
    })
    .default({
        antialiasing: false,
    });

const exampleSurface = z.enum(['examples', 'playground', 'home', 'none']);
const exampleSurfaces = z
    .array(exampleSurface)
    .min(1)
    .refine(surfaces => new Set(surfaces).size === surfaces.length, {
        message: 'Example surfaces must be unique.',
    })
    .default(['examples', 'playground']);
const hexColor = z.string().regex(/^#[\da-f]{6}$/i);
const exampleCoverImageUrl = z
    .string()
    .trim()
    .min(1)
    .refine(
        value => {
            if (value.startsWith('/')) {
                return true;
            }

            try {
                new URL(value);
                return true;
            } catch {
                return false;
            }
        },
        {
            message: 'Example coverImageUrl must be an absolute URL or a site-root path.',
        },
    );

const examples = defineCollection({
    loader: glob({
        base: './src/content/examples',
        pattern: '*.json',
    }),
    schema: z.object({
        order: z.number().int().nonnegative(),
        surfaces: exampleSurfaces,
        tags: z.array(z.string().min(1)).min(1),
        accent: hexColor,
        coverImageUrl: exampleCoverImageUrl,
        title: localizedText,
        renderer: renderSessionRendererOptions,
        showInteractionGuide: z.boolean().default(true),
    }),
});

export const collections = {
    examples,
};
