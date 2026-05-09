import type { Locale } from './locales';

type NavKey = 'home' | 'playground' | 'viewer' | 'api' | 'examples' | 'manual';

interface Dictionary {
    siteName: string;
    siteDescription: string;
    nav: Record<NavKey, string>;
    common: {
        run: string;
        preset: string;
        source: string;
    };
    examples: {
        title: string;
        description: string;
    };
    playground: {
        title: string;
        description: string;
        editor: string;
        preview: string;
        inspector: string;
        ready: string;
        error: string;
        fps: string;
        drawCalls: string;
        objects: string;
    };
    viewer: {
        title: string;
        description: string;
    };
}

export const dictionary: Record<Locale, Dictionary> = {
    'zh-CN': {
        siteName: 'Aholo Viewer',
        siteDescription: '能力丰富的 3D Gaussian Splatting 高性能渲染引擎。',
        nav: {
            home: '首页',
            playground: 'Playground',
            viewer: 'Viewer',
            api: 'API',
            examples: '示例',
            manual: '手册',
        },
        common: {
            run: '运行',
            preset: '预设',
            source: '源码',
        },
        examples: {
            title: '示例集合',
            description: '浏览渲染器示例，打开详情页查看预览、源码，并继续在 Playground 中编辑。',
        },
        playground: {
            title: 'Playground',
            description: '编辑示例代码，查看预览状态和基础渲染指标。',
            editor: '编辑器',
            preview: '渲染预览',
            inspector: '检查器',
            ready: '准备就绪',
            error: '运行出错',
            fps: 'FPS',
            drawCalls: 'Draw calls',
            objects: 'Objects',
        },
        viewer: {
            title: 'Viewer',
            description: '导入 3DGS 文件，查看基础文件信息，并调整渲染参数。',
        },
    },
    'en-US': {
        siteName: 'Aholo Viewer',
        siteDescription: 'A feature-rich, high-performance 3D Gaussian Splatting rendering engine.',
        nav: {
            home: 'Home',
            playground: 'Playground',
            viewer: 'Viewer',
            api: 'API',
            examples: 'Examples',
            manual: 'Manual',
        },
        common: {
            run: 'Run',
            preset: 'Preset',
            source: 'Source',
        },
        examples: {
            title: 'Example Collection',
            description:
                'Browse renderer examples, open detail pages to view previews and source code, then continue editing in the Playground.',
        },
        playground: {
            title: 'Playground',
            description: 'Edit example code, view preview status, and review basic rendering metrics.',
            editor: 'Editor',
            preview: 'Render Preview',
            inspector: 'Inspector',
            ready: 'Ready',
            error: 'Runtime error',
            fps: 'FPS',
            drawCalls: 'Draw calls',
            objects: 'Objects',
        },
        viewer: {
            title: 'Viewer',
            description: 'Import 3DGS files, inspect basic file information, and tune renderer parameters.',
        },
    },
};
