import { pathToFileURL } from 'node:url';
import semver from 'semver';

const prereleaseTags = new Set(['alpha', 'beta', 'rc']);

export function getReleaseConfig(version, makeLatest = false) {
    const parsed = semver.parse(version);
    if (!parsed) {
        throw new Error(`Invalid package version: ${version}`);
    }

    const prerelease = parsed.prerelease.length > 0;
    const distTag = prerelease ? parsed.prerelease[0] : 'latest';
    if (prerelease && !prereleaseTags.has(distTag)) {
        throw new Error(`Unsupported prerelease channel in ${version}; expected alpha, beta, or rc.`);
    }

    return {
        distTag,
        prerelease,
        makeLatest: !prerelease && makeLatest,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [version, makeLatest = 'false'] = process.argv.slice(2);
    if (makeLatest !== 'true' && makeLatest !== 'false') {
        throw new Error('The makeLatest argument must be true or false.');
    }
    const config = getReleaseConfig(version, makeLatest === 'true');
    process.stdout.write(`${config.distTag}|${config.prerelease}|${config.makeLatest}\n`);
}
