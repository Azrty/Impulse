<?php

namespace Pterodactyl\BlueprintFramework\Extensions\impulsemodmanager;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpKernel\Exception\HttpException;

class ModrinthClient
{
    private const BASE_URL = 'https://api.modrinth.com/v2';
    private const USER_AGENT = 'ImpulseModManager/0.3.2 (https://impulse.epivalent.com)';
    private const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

    public function search(string $query, string $minecraftVersion, string $loader): array
    {
        $facets = json_encode([
            ['project_type:mod'],
            ['categories:' . $loader],
            ['versions:' . $minecraftVersion],
        ]);

        return Cache::remember('impulsemodmanager:search:' . sha1($query . $facets), now()->addMinutes(5), function () use ($query, $facets) {
            return $this->request('/search', [
                'query' => $query,
                'facets' => $facets,
                'limit' => 30,
                'index' => 'relevance',
            ]);
        });
    }

    public function versions(string $project, string $minecraftVersion, string $loader): array
    {
        $key = $this->versionsCacheKey($project, $minecraftVersion, $loader);
        return Cache::remember($key, now()->addMinutes(10), function () use ($project, $minecraftVersion, $loader) {
            return $this->request('/project/' . rawurlencode($project) . '/version', [
                'game_versions' => json_encode([$minecraftVersion]),
                'loaders' => json_encode([$loader]),
                'include_changelog' => 'true',
            ]);
        });
    }

    public function cachedVersions(string $project, string $minecraftVersion, string $loader): ?array
    {
        $versions = Cache::get($this->versionsCacheKey($project, $minecraftVersion, $loader));
        return is_array($versions) ? $versions : null;
    }

    private function versionsCacheKey(string $project, string $minecraftVersion, string $loader): string
    {
        return 'impulsemodmanager:versions:' . sha1($project . $minecraftVersion . $loader);
    }

    public function version(string $version): array
    {
        return Cache::remember('impulsemodmanager:version:' . $version, now()->addMinutes(10), function () use ($version) {
            return $this->request('/version/' . rawurlencode($version));
        });
    }

    public function project(string $project): array
    {
        return Cache::remember('impulsemodmanager:project:' . $project, now()->addMinutes(10), function () use ($project) {
            return $this->request('/project/' . rawurlencode($project));
        });
    }

    public function versionFromHash(string $sha1): ?array
    {
        $sha1 = strtolower($sha1);
        if (!preg_match('/^[a-f0-9]{40}$/', $sha1)) return null;
        $result = Cache::remember('impulsemodmanager:file-version:' . $sha1, now()->addHours(6), function () use ($sha1) {
            return $this->request('/version_file/' . rawurlencode($sha1), ['algorithm' => 'sha1'], true);
        });
        return $result ?: null;
    }

    public function versionsFromHashes(array $hashes): array
    {
        $hashes = array_values(array_unique(array_filter(array_map('strtolower', $hashes), fn ($hash) => preg_match('/^[a-f0-9]{40}$/', $hash))));
        if (!$hashes) return [];
        sort($hashes);
        $results = [];
        foreach (array_chunk($hashes, 100) as $chunk) {
            $key = 'impulsemodmanager:file-versions:' . sha1(implode('|', $chunk));
            $batch = Cache::remember($key, now()->addHours(6), fn () => $this->post('/version_files', [
                'hashes' => $chunk,
                'algorithm' => 'sha1',
            ]));
            foreach ($batch as $hash => $version) if (is_array($version)) $results[strtolower($hash)] = $version;
        }
        return $results;
    }

    public function projects(array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('strval', $ids))));
        if (!$ids) return [];
        sort($ids);
        $results = [];
        foreach (array_chunk($ids, 100) as $chunk) {
            $key = 'impulsemodmanager:projects:' . sha1(implode('|', $chunk));
            $batch = Cache::remember($key, now()->addHours(6), fn () => $this->request('/projects', ['ids' => json_encode($chunk)]));
            foreach ($batch as $project) if (is_array($project) && !empty($project['id'])) $results[$project['id']] = $project;
        }
        return $results;
    }

    public function team(string $team): array
    {
        return Cache::remember('impulsemodmanager:team:' . $team, now()->addMinutes(30), fn () => $this->request('/team/' . rawurlencode($team) . '/members'));
    }

    private function request(string $path, array $query = [], bool $allowNotFound = false): array
    {
        return $this->send('get', $path, $query, $allowNotFound);
    }

    private function post(string $path, array $body): array
    {
        return $this->send('post', $path, $body, false);
    }

    private function send(string $method, string $path, array $data, bool $allowNotFound): array
    {
        $response = null;
        $lastException = null;

        for ($attempt = 1; $attempt <= 3; $attempt++) {
            try {
                $request = Http::acceptJson()
                    ->withUserAgent(self::USER_AGENT)
                    ->connectTimeout(5)
                    ->timeout(15);
                $response = $method === 'post'
                    ? $request->post(self::BASE_URL . $path, $data)
                    : $request->get(self::BASE_URL . $path, $data);

                if (!in_array($response->status(), self::RETRYABLE_STATUSES, true) || $attempt === 3) {
                    break;
                }
            } catch (\Throwable $exception) {
                $lastException = $exception;
                if ($attempt === 3) {
                    break;
                }
            }

            usleep($attempt * 250000);
        }

        if (!$response) {
            throw new HttpException(503, 'Modrinth is unavailable. Check the panel network connection and try again.', $lastException);
        }

        if ($allowNotFound && $response->status() === 404) return [];
        if ($response->status() === 429) {
            throw new HttpException(429, 'Modrinth rate limited this request. Try again shortly.');
        }
        if (!$response->successful()) {
            $remoteMessage = trim((string) ($response->json('description') ?: $response->json('error') ?: ''));
            $suffix = $remoteMessage !== '' ? ' ' . $remoteMessage : '';
            throw new HttpException(502, 'Modrinth returned HTTP ' . $response->status() . '.' . $suffix);
        }

        $payload = $response->json();
        if (!is_array($payload)) {
            throw new HttpException(502, 'Modrinth returned an invalid response.');
        }

        return $payload;
    }
}
