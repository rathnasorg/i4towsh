import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  isPhotoFile,
  getPhotosInDir,
  getSubdirs,
  sanitizeRepoName,
  createAlbum,
  processDirectory,
} from './index.js';

// Mock simple-git
vi.mock('simple-git', () => {
  const mockGit = {
    clone: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    addRemote: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockResolvedValue(undefined),
  };
  return {
    simpleGit: vi.fn(() => mockGit),
  };
});

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    cpSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { existsSync, readdirSync, statSync, cpSync, mkdirSync } from 'fs';
import { simpleGit } from 'simple-git';

describe('isPhotoFile', () => {
  it('should return true for jpg files', () => {
    expect(isPhotoFile('photo.jpg')).toBe(true);
    expect(isPhotoFile('photo.JPG')).toBe(true);
  });

  it('should return true for jpeg files', () => {
    expect(isPhotoFile('photo.jpeg')).toBe(true);
    expect(isPhotoFile('photo.JPEG')).toBe(true);
  });

  it('should return true for png files', () => {
    expect(isPhotoFile('photo.png')).toBe(true);
    expect(isPhotoFile('photo.PNG')).toBe(true);
  });

  it('should return true for heic files', () => {
    expect(isPhotoFile('photo.heic')).toBe(true);
    expect(isPhotoFile('photo.HEIC')).toBe(true);
  });

  it('should return true for webp files', () => {
    expect(isPhotoFile('photo.webp')).toBe(true);
  });

  it('should return false for non-photo files', () => {
    expect(isPhotoFile('document.pdf')).toBe(false);
    expect(isPhotoFile('video.mp4')).toBe(false);
    expect(isPhotoFile('readme.txt')).toBe(false);
    expect(isPhotoFile('script.js')).toBe(false);
  });

  it('should handle files without extension', () => {
    expect(isPhotoFile('noextension')).toBe(false);
  });
});

describe('sanitizeRepoName', () => {
  it('should remove spaces', () => {
    expect(sanitizeRepoName('My Album')).toBe('MyAlbum');
    expect(sanitizeRepoName('  spaced  out  ')).toBe('spacedout');
  });

  it('should remove special characters', () => {
    expect(sanitizeRepoName('album@2024!')).toBe('album2024');
    expect(sanitizeRepoName('photo#gallery$')).toBe('photogallery');
  });

  it('should keep allowed characters', () => {
    expect(sanitizeRepoName('my-album_2024')).toBe('my-album_2024');
    expect(sanitizeRepoName('Album123')).toBe('Album123');
  });

  it('should handle empty string', () => {
    expect(sanitizeRepoName('')).toBe('');
  });
});

describe('getPhotosInDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array if directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getPhotosInDir('/nonexistent')).toEqual([]);
  });

  it('should return only photo files', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      'photo1.jpg',
      'photo2.png',
      'document.pdf',
      'video.mp4',
    ] as any);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);

    const result = getPhotosInDir('/photos');
    expect(result).toEqual(['photo1.jpg', 'photo2.png']);
  });

  it('should exclude directories', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['photo.jpg', 'subdir'] as any);
    vi.mocked(statSync).mockImplementation((path: any) => ({
      isFile: () => !path.includes('subdir'),
    }) as any);

    const result = getPhotosInDir('/photos');
    expect(result).toEqual(['photo.jpg']);
  });
});

describe('getSubdirs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array if directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getSubdirs('/nonexistent')).toEqual([]);
  });

  it('should return only directories', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['album1', 'album2', 'file.txt'] as any);
    vi.mocked(statSync).mockImplementation((path: any) => ({
      isDirectory: () => !path.includes('file.txt'),
    }) as any);

    const result = getSubdirs('/photos');
    expect(result).toEqual(['album1', 'album2']);
  });

  it('should exclude hidden directories', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['album1', '.hidden', '.git'] as any);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

    const result = getSubdirs('/photos');
    expect(result).toEqual(['album1']);
  });
});

describe('createAlbum', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['photo1.jpg', 'photo2.png'] as any);
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
  });

  it('should return dry run result without making API calls', async () => {
    const result = await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
    });

    expect(result).toEqual({
      name: 'i4tow-MyAlbum',
      repoUrl: 'https://github.com/testuser/i4tow-MyAlbum',
      success: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should prefix repo name with i4tow- if not already prefixed', async () => {
    const result = await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
    });

    expect(result.name).toBe('i4tow-MyAlbum');
  });

  it('should not double-prefix if already has i4tow-', async () => {
    const result = await createAlbum('/photos', 'i4tow-MyAlbum', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
    });

    expect(result.name).toBe('i4tow-MyAlbum');
  });

  it('should create GitHub repo and clone template', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 123 }),
    });

    const result = await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe('i4tow-MyAlbum');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user/repos',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'token test-token',
        }),
      })
    );
  });

  it('should handle repo already exists gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({
        message: 'Repository creation failed',
        errors: [{ message: 'name already exists on this account' }],
      }),
    });

    const result = await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
    });

    expect(result.success).toBe(true);
  });

  it('should return error if GitHub API fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({
        message: 'Bad credentials',
      }),
    });

    const result = await createAlbum('/photos', 'MyAlbum', {
      token: 'invalid-token',
      username: 'testuser',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Bad credentials');
  });

  it('should clone template repo with depth 1', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 123 }),
    });

    await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
    });

    const git = simpleGit();
    expect(git.clone).toHaveBeenCalledWith(
      'https://github.com/rathnasorg/i4tow-album.git',
      expect.any(String),
      ['--depth', '1']
    );
  });

  it('should initialize git repo and push', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 123 }),
    });

    await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
    });

    const git = simpleGit();
    expect(git.init).toHaveBeenCalled();
    expect(git.addRemote).toHaveBeenCalledWith(
      'origin',
      'https://testuser:test-token@github.com/testuser/i4tow-MyAlbum.git'
    );
    expect(git.add).toHaveBeenCalledWith('.');
    expect(git.commit).toHaveBeenCalledWith(expect.stringContaining('photos added @'));
    expect(git.push).toHaveBeenCalledWith('origin', 'main', ['--set-upstream']);
  });

  it('should copy photos to public/photos/raw2', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 123 }),
    });

    await createAlbum('/photos', 'MyAlbum', {
      token: 'test-token',
      username: 'testuser',
    });

    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(join('public', 'photos', 'raw2')),
      { recursive: true }
    );
    expect(cpSync).toHaveBeenCalledTimes(3); // 2 photos + 1 .git backup
  });
});

describe('processDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create single album when dir has photos but no subdirs', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['photo1.jpg', 'photo2.jpg'] as any);
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as any);

    const results = await processDirectory('/photos/MyAlbum', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('i4tow-MyAlbum');
  });

  it('should create multiple albums in batch mode', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation((dir: any) => {
      if (dir === '/photos') {
        return ['Album1', 'Album2'] as any;
      }
      return ['photo.jpg'] as any;
    });
    vi.mocked(statSync).mockImplementation((path: any) => {
      const isSubdir = path.includes('Album1') || path.includes('Album2');
      return {
        isFile: () => path.includes('photo.jpg'),
        isDirectory: () => isSubdir && !path.includes('photo.jpg'),
      } as any;
    });

    const results = await processDirectory('/photos', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
      batch: true,
    });

    expect(results).toHaveLength(2);
    expect(results.map(r => r.name)).toContain('i4tow-Album1');
    expect(results.map(r => r.name)).toContain('i4tow-Album2');
  });

  it('should force single mode with --single flag', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation((dir: any) => {
      if (dir === '/photos') {
        return ['photo.jpg', 'Album1'] as any;
      }
      return ['photo.jpg'] as any;
    });
    vi.mocked(statSync).mockImplementation((path: any) => ({
      isFile: () => path.includes('photo.jpg'),
      isDirectory: () => path.includes('Album1') && !path.includes('photo.jpg'),
    }) as any);

    const results = await processDirectory('/photos', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
      single: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('i4tow-photos');
  });

  it('should skip subdirs without photos', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockImplementation((dir: any) => {
      if (dir === '/photos') {
        return ['AlbumWithPhotos', 'EmptyAlbum'] as any;
      }
      if (dir.includes('AlbumWithPhotos')) {
        return ['photo.jpg'] as any;
      }
      return [] as any; // EmptyAlbum has no photos
    });
    vi.mocked(statSync).mockImplementation((path: any) => ({
      isFile: () => path.includes('photo.jpg'),
      isDirectory: () => (path.includes('AlbumWithPhotos') || path.includes('EmptyAlbum')) && !path.includes('photo.jpg'),
    }) as any);

    const results = await processDirectory('/photos', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
      batch: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('i4tow-AlbumWithPhotos');
  });

  it('should return empty array when no photos found', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([] as any);

    const results = await processDirectory('/empty', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
    });

    expect(results).toHaveLength(0);
  });

  it('should sanitize directory names for repo names', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['photo.jpg'] as any);
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      isDirectory: () => false,
    } as any);

    const results = await processDirectory('/photos/My Album @ 2024!', {
      token: 'test-token',
      username: 'testuser',
      dryRun: true,
    });

    expect(results[0].name).toBe('i4tow-MyAlbum2024');
  });
});
