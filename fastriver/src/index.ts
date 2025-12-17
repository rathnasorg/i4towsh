import { simpleGit } from 'simple-git';
import { existsSync, readdirSync, statSync, cpSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import sealedbox from 'tweetnacl-sealedbox-js';

export interface AlbumOptions {
  token: string;
  username: string;
  dryRun?: boolean;
  onProgress?: (step: string, detail?: string) => void;
}

export interface AlbumResult {
  name: string;
  repoUrl: string;
  albumUrl: string;
  success: boolean;
  error?: string;
  photoCount?: number;
}

const TEMPLATE_REPO = 'https://github.com/rathnasorg/i4tow-album.git';
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isPhotoFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return PHOTO_EXTENSIONS.includes(ext);
}

export function getPhotosInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => {
      const fullPath = join(dir, f);
      try {
        return statSync(fullPath).isFile() && isPhotoFile(f);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function getSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => {
      const fullPath = join(dir, f);
      try {
        return statSync(fullPath).isDirectory() && !f.startsWith('.');
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function sanitizeRepoName(name: string): string {
  return name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_-]/g, '');
}

async function createGitHubRepo(
  name: string,
  token: string,
  username: string
): Promise<{ success: boolean; error?: string; alreadyExists?: boolean }> {
  const headers = {
    Authorization: `token ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'i4tow-cli',
  };

  try {
    // First, check if username is an org or the authenticated user
    const userResponse = await fetch('https://api.github.com/user', { headers });
    if (!userResponse.ok) {
      return { success: false, error: 'Invalid GitHub token. Check your token and try again.' };
    }
    const userData = (await userResponse.json()) as { login: string };
    const authenticatedUser = userData.login;

    // Determine the correct API endpoint
    let apiUrl: string;
    if (username.toLowerCase() === authenticatedUser.toLowerCase()) {
      // Creating under personal account
      apiUrl = 'https://api.github.com/user/repos';
    } else {
      // Creating under an organization
      apiUrl = `https://api.github.com/orgs/${username}/repos`;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, private: false }),
    });

    if (!response.ok) {
      const data = (await response.json()) as {
        message?: string;
        errors?: { message?: string }[];
      };
      if (data.errors?.[0]?.message?.includes('already exists')) {
        return { success: true, alreadyExists: true };
      }
      if (data.message === 'Bad credentials') {
        return { success: false, error: 'Invalid GitHub token. Check your token and try again.' };
      }
      if (data.message === 'Not Found') {
        return {
          success: false,
          error: `Cannot create repo under "${username}". Ensure token has access to this account/org.`,
        };
      }
      return { success: false, error: data.message || 'Failed to create repository' };
    }

    // Verify the repo was created by checking the response
    const repoData = (await response.json()) as { full_name?: string };
    if (!repoData.full_name) {
      return { success: false, error: 'Repository creation failed - no repo returned' };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('fetch')) {
        return { success: false, error: 'Network error. Check your internet connection.' };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: 'Unknown error creating repository' };
  }
}

async function createRepoSecret(
  repoOwner: string,
  repoName: string,
  secretName: string,
  secretValue: string,
  token: string
): Promise<{ success: boolean; error?: string }> {
  const headers = {
    Authorization: `token ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'i4tow-cli',
  };

  try {
    // Step 1: Get the repository's public key
    const keyResponse = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/actions/secrets/public-key`,
      { headers }
    );

    if (!keyResponse.ok) {
      return { success: false, error: 'Failed to get repository public key' };
    }

    const keyData = (await keyResponse.json()) as { key: string; key_id: string };

    // Step 2: Encrypt the secret using libsodium sealed box
    const publicKey = Buffer.from(keyData.key, 'base64');
    const secretBytes = Buffer.from(secretValue);
    const encryptedBytes = sealedbox.seal(secretBytes, publicKey);
    const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

    // Step 3: Create/update the secret
    const secretResponse = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: keyData.key_id,
        }),
      }
    );

    if (!secretResponse.ok) {
      const errorData = (await secretResponse.json()) as { message?: string };
      return { success: false, error: errorData.message || 'Failed to create secret' };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: 'Unknown error creating secret' };
  }
}

export async function createAlbum(
  sourceDir: string,
  repoName: string,
  options: AlbumOptions
): Promise<AlbumResult> {
  const { token, username, dryRun, onProgress } = options;
  const fullRepoName = repoName.startsWith('i4tow-') ? repoName : `i4tow-${repoName}`;
  const photos = getPhotosInDir(sourceDir);
  const albumUrl = `https://rathnasorg.github.io/i4tow/a/${fullRepoName}`;

  const progress = (step: string, detail?: string) => {
    if (onProgress) onProgress(step, detail);
  };

  if (photos.length === 0) {
    return {
      name: fullRepoName,
      repoUrl: '',
      albumUrl: '',
      success: false,
      error: 'No photos found in directory',
      photoCount: 0,
    };
  }

  if (dryRun) {
    return {
      name: fullRepoName,
      repoUrl: `https://github.com/${username}/${fullRepoName}`,
      albumUrl,
      success: true,
      photoCount: photos.length,
    };
  }

  try {
    // Step 1: Create GitHub repo
    progress('Creating repository', fullRepoName);
    const createResult = await createGitHubRepo(fullRepoName, token, username);
    if (!createResult.success) {
      return {
        name: fullRepoName,
        repoUrl: '',
        albumUrl: '',
        success: false,
        error: createResult.error,
        photoCount: photos.length,
      };
    }
    if (createResult.alreadyExists) {
      progress('Repository exists', 'Using existing repository');
    } else {
      // Wait for GitHub to provision the new repo
      progress('Waiting for GitHub', 'Repository provisioning...');
      await sleep(3000);
    }

    // Step 2: Clone template
    progress('Downloading template', 'rathnasorg/i4tow-album');
    const tempDir = join(tmpdir(), `i4tow-${Date.now()}`);
    const git = simpleGit();
    await git.clone(TEMPLATE_REPO, tempDir, ['--depth', '1']);

    // Step 3: Clean up template
    progress('Preparing album', 'Cleaning template files');
    const tempGit = join(tempDir, '.git');
    const tempDemo = join(tempDir, 'temp-demo-files');
    if (existsSync(tempGit)) {
      rmSync(tempGit, { recursive: true, force: true });
    }
    if (existsSync(tempDemo)) {
      rmSync(tempDemo, { recursive: true, force: true });
    }

    // Step 4: Copy photos
    progress('Copying photos', `${photos.length} files`);
    const photosDir = join(tempDir, 'public', 'photos', 'raw2');
    mkdirSync(photosDir, { recursive: true });

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      cpSync(join(sourceDir, photo), join(photosDir, photo));
    }

    // Step 5: Initialize git and push
    progress('Uploading to GitHub', `Pushing to ${username}/${fullRepoName}`);
    const repoUrl = `https://${username}:${token}@github.com/${username}/${fullRepoName}.git`;
    const localGit = simpleGit(tempDir);
    await localGit.init();
    await localGit.addRemote('origin', repoUrl);
    await localGit.add('.');
    await localGit.commit(`${photos.length} photos added via i4tow`);

    // Push with retry logic (GitHub may need more time to provision)
    let pushAttempts = 0;
    const maxAttempts = 3;
    while (pushAttempts < maxAttempts) {
      try {
        await localGit.push('origin', 'main', ['--set-upstream', '--force']);
        break;
      } catch (pushError) {
        pushAttempts++;
        if (pushAttempts >= maxAttempts) {
          throw pushError;
        }
        progress('Retrying push', `Attempt ${pushAttempts + 1}/${maxAttempts}...`);
        await sleep(2000);
      }
    }

    // Step 6: Create DEPLOY_TOKEN secret for GitHub Actions
    progress('Setting up Actions', 'Creating deploy token...');
    const secretResult = await createRepoSecret(username, fullRepoName, 'DEPLOY_TOKEN', token, token);
    if (!secretResult.success) {
      // Non-fatal: workflow may still work with GITHUB_TOKEN
      progress('Warning', `Could not create deploy secret: ${secretResult.error}`);
    }

    // Cleanup temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    return {
      name: fullRepoName,
      repoUrl: `https://github.com/${username}/${fullRepoName}`,
      albumUrl,
      success: true,
      photoCount: photos.length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Provide helpful error messages
    let friendlyError = errorMessage;
    if (errorMessage.includes('Authentication failed')) {
      friendlyError = 'GitHub authentication failed. Check your token.';
    } else if (errorMessage.includes('Permission denied')) {
      friendlyError = 'Permission denied. Ensure token has "repo" scope.';
    } else if (errorMessage.includes('Repository not found')) {
      friendlyError = 'Repository not found. It may still be creating, try again in a moment.';
    }

    return {
      name: fullRepoName,
      repoUrl: '',
      albumUrl: '',
      success: false,
      error: friendlyError,
      photoCount: photos.length,
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

  const hasPhotos = photos.length > 0;
  const hasSubdirs = subdirs.length > 0;

  if (options.single || (hasPhotos && !hasSubdirs) || (hasPhotos && !options.batch)) {
    const name = sanitizeRepoName(basename(dir));
    const result = await createAlbum(dir, name, options);
    results.push(result);
  } else if (options.batch || hasSubdirs) {
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
