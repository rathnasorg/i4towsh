import { simpleGit } from 'simple-git';
import { existsSync, readdirSync, statSync, cpSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';

export interface AlbumOptions {
  token: string;
  username: string;
  dryRun?: boolean;
}

export interface AlbumResult {
  name: string;
  repoUrl: string;
  success: boolean;
  error?: string;
}

const TEMPLATE_REPO = 'https://github.com/rathnasorg/i4tow-album.git';
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.webp'];

export function isPhotoFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return PHOTO_EXTENSIONS.includes(ext);
}

export function getPhotosInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    const fullPath = join(dir, f);
    return statSync(fullPath).isFile() && isPhotoFile(f);
  });
}

export function getSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    const fullPath = join(dir, f);
    return statSync(fullPath).isDirectory() && !f.startsWith('.');
  });
}

export function sanitizeRepoName(name: string): string {
  return name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '');
}

async function createGitHubRepo(
  name: string,
  token: string
): Promise<{ success: boolean; error?: string }> {
  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'i4tow-cli',
    },
    body: JSON.stringify({ name, private: false }),
  });

  if (!response.ok) {
    const data = (await response.json()) as {
      message?: string;
      errors?: { message?: string }[];
    };
    if (data.errors?.[0]?.message?.includes('already exists')) {
      return { success: true }; // Repo exists, that's fine
    }
    return { success: false, error: data.message || 'Failed to create repo' };
  }
  return { success: true };
}


export async function createAlbum(
  sourceDir: string,
  repoName: string,
  options: AlbumOptions
): Promise<AlbumResult> {
  const { token, username, dryRun } = options;
  const fullRepoName = repoName.startsWith('i4tow-') ? repoName : `i4tow-${repoName}`;

  if (dryRun) {
    return {
      name: fullRepoName,
      repoUrl: `https://github.com/${username}/${fullRepoName}`,
      success: true,
    };
  }

  try {
    // 1. Create GitHub repo
    const createResult = await createGitHubRepo(fullRepoName, token);
    if (!createResult.success) {
      return {
        name: fullRepoName,
        repoUrl: '',
        success: false,
        error: createResult.error,
      };
    }

    // 2. Clone template to temp dir
    const tempDir = join(tmpdir(), `i4tow-${Date.now()}`);
    const git = simpleGit();
    await git.clone(TEMPLATE_REPO, tempDir, ['--depth', '1']);

    // 3. Remove .git and temp-demo-files
    const tempGit = join(tempDir, '.git');
    const tempDemo = join(tempDir, 'temp-demo-files');
    if (existsSync(tempGit)) {
      cpSync(tempGit, tempGit + '.bak', { recursive: true }); // backup
      await simpleGit(tempDir).raw(['rm', '-rf', '.git']);
    }
    if (existsSync(tempDemo)) {
      await simpleGit(tempDir).raw(['rm', '-rf', 'temp-demo-files']);
    }

    // 4. Copy photos
    const photosDir = join(tempDir, 'public', 'photos', 'raw2');
    mkdirSync(photosDir, { recursive: true });

    const photos = getPhotosInDir(sourceDir);
    for (const photo of photos) {
      cpSync(join(sourceDir, photo), join(photosDir, photo));
    }

    // 5. Init new git repo and push
    const repoUrl = `https://${username}:${token}@github.com/${username}/${fullRepoName}.git`;
    const localGit = simpleGit(tempDir);
    await localGit.init();
    await localGit.addRemote('origin', repoUrl);
    await localGit.add('.');
    await localGit.commit(`photos added @ ${new Date().toISOString()}`);
    await localGit.push('origin', 'main', ['--set-upstream']);

    return {
      name: fullRepoName,
      repoUrl: `https://github.com/${username}/${fullRepoName}`,
      success: true,
    };
  } catch (error) {
    return {
      name: fullRepoName,
      repoUrl: '',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function processDirectory(
  dir: string,
  options: AlbumOptions & { batch?: boolean; single?: boolean }
): Promise<AlbumResult[]> {
  const results: AlbumResult[] = [];
  const photos = getPhotosInDir(dir);
  const subdirs = getSubdirs(dir);

  // Determine mode
  const hasPhotos = photos.length > 0;
  const hasSubdirs = subdirs.length > 0;

  if (options.single || (hasPhotos && !hasSubdirs) || (hasPhotos && !options.batch)) {
    // Single album mode - current dir becomes the album
    const name = sanitizeRepoName(basename(dir));
    const result = await createAlbum(dir, name, options);
    results.push(result);
  } else if (options.batch || hasSubdirs) {
    // Batch mode - each subdir becomes an album
    for (const subdir of subdirs) {
      const subdirPath = join(dir, subdir);
      const subdirPhotos = getPhotosInDir(subdirPath);
      if (subdirPhotos.length > 0) {
        const name = sanitizeRepoName(subdir);
        const result = await createAlbum(subdirPath, name, options);
        results.push(result);
      }
    }
  }

  return results;
}
