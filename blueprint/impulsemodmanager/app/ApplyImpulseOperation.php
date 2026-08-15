<?php

namespace Pterodactyl\BlueprintFramework\Extensions\impulsemodmanager;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Pterodactyl\Models\Server;

class ApplyImpulseOperation implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $timeout = 900;

    public function __construct(public string $operationId)
    {
    }

    public function handle(ImpulseManagerService $manager, ModrinthClient $modrinth): void
    {
        $operation = ImpulseOperation::find($this->operationId);
        if (!$operation || in_array($operation->state, ['succeeded', 'failed', 'rolled_back'], true)) return;
        $operation->update(['state' => 'running']);
        $this->log($operation, 'Starting immediate file transaction. The server will not be restarted.');

        $server = Server::findOrFail($operation->server_id);
        try {
            if (($operation->payload['type'] ?? '') === 'remove') {
                $this->remove($manager, $server, $operation);
            } else {
                $this->install($manager, $modrinth, $server, $operation);
            }
            $operation->update(['state' => 'succeeded']);
            $this->log($operation, 'Completed. Restart the server later only if server-side jars changed.');
        } catch (\Throwable $exception) {
            $operation->update(['state' => 'failed']);
            $this->log($operation, 'Failed: ' . $exception->getMessage());
        }
    }

    public function previewPlan(ImpulseManagerService $manager, ModrinthClient $modrinth, Server $server, array $payload): array
    {
        return array_map(function (array $item) use ($payload) {
            return [
                'projectId' => $item['project_id'],
                'name' => $item['project']['title'] ?? $item['version']['name'] ?? $item['file']['filename'],
                'versionId' => $item['version']['id'] ?? '',
                'version' => $item['version']['version_number'] ?? '',
                'filename' => $item['file']['filename'],
                'size' => (int) ($item['file']['size'] ?? 0),
                'sha1' => $item['file']['hashes']['sha1'] ?? '',
                'paths' => $item['paths'],
                'dependency' => $item['project_id'] !== ($payload['project_id'] ?? ''),
            ];
        }, $this->resolvePlan($manager, $modrinth, $server, $payload));
    }

    private function install(ImpulseManagerService $manager, ModrinthClient $modrinth, Server $server, ImpulseOperation $operation): void
    {
        $payload = $operation->payload;
        $plan = $this->resolvePlan($manager, $modrinth, $server, $payload);
        $this->log($operation, 'Resolved ' . count($plan) . ' compatible Modrinth file(s), including required dependencies.');
        $manager->ensureImpulseDirectories($server);
        $state = $manager->state($server);
        $added = [];
        $backups = [];

        try {
            foreach ($plan as $item) {
                $ownedPaths = [];
                $previousEntries = array_values(array_filter($state['files'] ?? [], fn ($entry) => ($entry['project_id'] ?? '') === $item['project_id']));
                foreach ($item['paths'] as $target) {
                    $directory = dirname($target);
                    $this->ensurePath($manager, $server, $directory);
                    $existing = $this->managedAtPath($state, $target);
                    $existingFile = $this->fileEntry($manager, $server, $directory, basename($target));
                    if ($existingFile) {
                        $inspection = $manager->inspectJar($server, $target, (int) ($existingFile['size'] ?? 0));
                        $expectedSha1 = strtolower((string) ($item['file']['hashes']['sha1'] ?? ''));
                        $actualSha1 = strtolower((string) ($inspection['sha1'] ?? ''));
                        if ($actualSha1 !== '' && hash_equals($expectedSha1, $actualSha1)) {
                            $label = $inspection['name'] ?? $item['project']['title'] ?? $item['file']['filename'];
                            $this->log($operation, 'Reusing existing verified jar ' . $label . ' at ' . $target . '.');
                            if ($existing && ($this->isOwnedPath($existing, $target) || !empty($payload['take_ownership']))) $ownedPaths[] = $target;
                            continue;
                        }
                        if (!$existing || (!$this->isOwnedPath($existing, $target) && empty($payload['take_ownership']))) {
                            $label = $inspection['name'] ?? basename($target);
                            $version = !empty($inspection['version']) ? ' ' . $inspection['version'] : '';
                            $identity = !empty($inspection['project_id']) ? ' (Modrinth project ' . $inspection['project_id'] . ')' : '';
                            throw new \RuntimeException('Cannot replace unmanaged jar ' . $target . ': detected ' . $label . $version . $identity . ', but the requested file has a different SHA-1. Remove, relocate, or import that jar first.');
                        }
                        if (!$this->isOwnedPath($existing, $target) && !empty($payload['take_ownership'])) $this->log($operation, 'Taking ownership of explicitly updated jar ' . $target . '.');
                    }
                    $stageDirectory = 'impulse/.manager/staging/' . $operation->id;
                    $this->ensurePath($manager, $server, $stageDirectory);
                    $stageName = substr(sha1($target), 0, 12) . '-' . basename($target);
                    $stagePath = $stageDirectory . '/' . $stageName;
                    $this->log($operation, 'Downloading ' . $item['file']['filename'] . ' to staging.');
                    $manager->repository($server)->pull($item['file']['url'], $stageDirectory, [
                        'filename' => $stageName,
                        'foreground' => true,
                    ]);
                    $this->verifyRemoteFile($manager, $server, $stagePath, $item['file']);

                    if ($existingFile) {
                        $rollbackDirectory = 'impulse/.manager/rollback/' . $operation->id;
                        $this->ensurePath($manager, $server, $rollbackDirectory);
                        $backup = $rollbackDirectory . '/' . substr(sha1($target), 0, 12) . '-' . basename($target);
                        $manager->repository($server)->renameFiles('/', [['from' => $target, 'to' => $backup]]);
                        $backups[] = ['from' => $backup, 'to' => $target];
                    }
                    $manager->repository($server)->renameFiles('/', [['from' => $stagePath, 'to' => $target]]);
                    $added[] = $target;
                    $ownedPaths[] = $target;
                }
                foreach ($previousEntries as $previous) {
                    foreach (array_diff($previous['paths'] ?? [], $item['paths']) as $oldPath) {
                        $oldDirectory = dirname($oldPath);
                        if (!$this->fileEntry($manager, $server, $oldDirectory, basename($oldPath))) continue;
                        if (!$this->isOwnedPath($previous, $oldPath) && empty($payload['take_ownership'])) continue;
                        $rollbackDirectory = 'impulse/.manager/rollback/' . $operation->id;
                        $this->ensurePath($manager, $server, $rollbackDirectory);
                        $backup = $rollbackDirectory . '/' . substr(sha1($oldPath), 0, 12) . '-' . basename($oldPath);
                        $manager->repository($server)->renameFiles('/', [['from' => $oldPath, 'to' => $backup]]);
                        $backups[] = ['from' => $backup, 'to' => $oldPath];
                        $this->log($operation, 'Replacing previous version ' . $oldPath . '.');
                    }
                }
                $state['files'] = array_values(array_filter($state['files'], fn ($entry) => ($entry['project_id'] ?? '') !== $item['project_id']));
                $state['files'][] = [
                    'key' => $item['project_id'] . ':' . $item['version']['id'],
                    'project_id' => $item['project_id'],
                    'version_id' => $item['version']['id'],
                    'name' => $item['project']['title'] ?? $item['version']['name'] ?? $item['file']['filename'],
                    'description' => $item['project']['description'] ?? '',
                    'version' => $item['version']['version_number'] ?? '',
                    'sha1' => $item['file']['hashes']['sha1'],
                    'filename' => $item['file']['filename'],
                    'placement' => $item['placement'],
                    'category_id' => $item['category_id'],
                    'paths' => $item['paths'],
                    'owned_paths' => array_values(array_unique($ownedPaths)),
                    'source' => 'modrinth',
                    'dependencies' => array_values(array_unique(array_filter(array_map(fn ($dependency) => ($dependency['dependency_type'] ?? '') === 'required' ? ($dependency['project_id'] ?? null) : null, $item['version']['dependencies'] ?? [])))),
                    'dependencies_hydrated' => true,
                    'dependencies_schema' => 2,
                    'metadata_hydrated' => true,
                    'metadata_schema' => 2,
                    'conflicts' => $state['relationships']['conflicts'][$item['project_id']] ?? [],
                    'update_policy' => $payload['update_policy'] ?? 'release',
                ];
                if (in_array($item['placement'], ['server', 'required', 'optional-both'], true)) $state['restart_required'] = true;
            }
            $manager->saveState($server, $state);
            foreach ($backups as $backup) {
                try { $manager->repository($server)->deleteFiles('/', [$backup['from']]); } catch (\Throwable) { }
            }
        } catch (\Throwable $exception) {
            $this->log($operation, 'Rolling back managed files after failure.');
            foreach (array_reverse($added) as $path) {
                try { $manager->repository($server)->deleteFiles('/', [$path]); } catch (\Throwable) { }
            }
            foreach (array_reverse($backups) as $backup) {
                try { $manager->repository($server)->renameFiles('/', [['from' => $backup['from'], 'to' => $backup['to']]]); } catch (\Throwable) { }
            }
            throw $exception;
        }
    }

    private function remove(ImpulseManagerService $manager, Server $server, ImpulseOperation $operation): void
    {
        $managed = $manager->managedFile($server, (string) $operation->payload['key']);
        if (!$managed) throw new \RuntimeException('This managed jar no longer exists in Impulse Mod Manager state.');
        $ownedPaths = array_key_exists('owned_paths', $managed) ? ($managed['owned_paths'] ?? []) : ($managed['paths'] ?? []);
        foreach ($ownedPaths as $path) {
            $this->log($operation, 'Removing managed file ' . $path . '.');
            $manager->repository($server)->deleteFiles('/', [$path]);
        }
        foreach (array_diff($managed['paths'] ?? [], $ownedPaths) as $path) $this->log($operation, 'Preserving externally owned jar ' . $path . '.');
        $manager->removeStateFile($server, (string) $operation->payload['key']);
        if (in_array($managed['placement'] ?? '', ['server', 'required', 'optional-both'], true)) {
            $state = $manager->state($server);
            $state['restart_required'] = true;
            $manager->saveState($server, $state);
        }
    }

    private function resolvePlan(ImpulseManagerService $manager, ModrinthClient $modrinth, Server $server, array $payload): array
    {
        $runtime = $payload['runtime'];
        $placement = $payload['placement'];
        $category = $payload['category_id'] ?? null;
        $categoryInfo = $category ? $manager->categoryById($server, $category) : null;
        if (str_starts_with($placement, 'optional') && !$categoryInfo) throw new \RuntimeException('The selected optional category no longer exists.');

        $seen = [];
        $walk = function (string $project, string $versionId) use (&$walk, &$seen, $modrinth, $runtime, $placement, $category, $categoryInfo) {
            if (isset($seen[$project])) return;
            $version = $modrinth->version($versionId);
            $dependencies = $version['dependencies'] ?? [];
            foreach ($dependencies as $index => $dependency) {
                if (($dependency['dependency_type'] ?? '') !== 'required' || !empty($dependency['project_id']) || empty($dependency['version_id'])) continue;
                $dependencyVersion = $modrinth->version($dependency['version_id']);
                if (!empty($dependencyVersion['project_id'])) $dependencies[$index]['project_id'] = $dependencyVersion['project_id'];
            }
            $version['dependencies'] = $dependencies;
            $projectDetails = $modrinth->project($project);
            $this->assertCompatible($version, $runtime, $placement);
            $file = $this->primaryFile($version);
            $seen[$project] = [
                'project_id' => $project,
                'version' => $version,
                'project' => $projectDetails,
                'file' => $file,
                'placement' => $placement,
                'category_id' => $category,
                'paths' => $this->pathsFor($placement, $file['filename'], $categoryInfo['folder'] ?? null),
            ];
            foreach (($version['dependencies'] ?? []) as $dependency) {
                if (($dependency['dependency_type'] ?? '') !== 'required') continue;
                $dependencyProject = $dependency['project_id'] ?? null;
                $dependencyVersion = $dependency['version_id'] ?? null;
                if (!$dependencyProject) throw new \RuntimeException('A required Modrinth dependency has no project identity.');
                if (!$dependencyVersion) {
                    $versions = $modrinth->versions($dependencyProject, $runtime['minecraftVersion'], $runtime['loader']);
                    $dependencyVersion = $versions[0]['id'] ?? null;
                }
                if (!$dependencyVersion) throw new \RuntimeException('No compatible required dependency was found for ' . $dependencyProject . '.');
                $walk($dependencyProject, $dependencyVersion);
            }
        };
        $walk($payload['project_id'], $payload['version_id']);

        $state = $manager->state($server);
        $plannedIds = array_keys($seen);
        $conflictsById = [];
        foreach ($state['files'] ?? [] as $installed) {
            $installedId = (string) ($installed['project_id'] ?? '');
            if ($installedId !== '') $conflictsById[$installedId] = array_values(array_unique($installed['conflicts'] ?? ($state['relationships']['conflicts'][$installedId] ?? [])));
        }
        foreach ($plannedIds as $plannedId) {
            $plannedConflicts = $conflictsById[$plannedId] ?? ($state['relationships']['conflicts'][$plannedId] ?? []);
            foreach ($plannedIds as $otherPlannedId) {
                if ($plannedId !== $otherPlannedId && in_array($otherPlannedId, $plannedConflicts, true) && empty($payload['allow_conflicts'])) {
                    throw new \RuntimeException($plannedId . ' conflicts with planned mod ' . $otherPlannedId . '. Enable the manual conflict override to continue.');
                }
            }
            foreach ($state['files'] ?? [] as $installed) {
                $installedId = (string) ($installed['project_id'] ?? '');
                if ($installedId === '' || in_array($installedId, $plannedIds, true)) continue;
                $installedConflicts = $conflictsById[$installedId] ?? [];
                if ((in_array($installedId, $plannedConflicts, true) || in_array($plannedId, $installedConflicts, true)) && empty($payload['allow_conflicts'])) {
                    throw new \RuntimeException($plannedId . ' conflicts with installed mod ' . $installedId . '. Enable the manual conflict override to continue.');
                }
            }
        }
        foreach ($seen as $entry) {
            foreach ($state['files'] as $installed) {
                if (($installed['project_id'] ?? '') === $entry['project_id'] && ($installed['version_id'] ?? '') !== ($entry['version']['id'] ?? '')) {
                    if (empty($payload['allow_conflicts']) && empty($payload['take_ownership'])) throw new \RuntimeException('A different managed version of ' . $entry['project_id'] . ' is already installed. Confirm a manual override to replace it.');
                }
            }
        }
        $this->assertNoDuplicateClientFilenames(array_values($seen));
        return array_values($seen);
    }

    private function primaryFile(array $version): array
    {
        foreach (($version['files'] ?? []) as $file) if (!empty($file['primary'])) return $file;
        $file = $version['files'][0] ?? null;
        if (!$file || empty($file['url']) || empty($file['hashes']['sha1']) || empty($file['filename'])) throw new \RuntimeException('The selected Modrinth version has no downloadable SHA-1 verified jar.');
        return $file;
    }

    private function assertCompatible(array $version, array $runtime, string $placement): void
    {
        if (!in_array($runtime['loader'], $version['loaders'] ?? [], true) || !in_array($runtime['minecraftVersion'], $version['game_versions'] ?? [], true)) throw new \RuntimeException('Modrinth returned an incompatible dependency.');
        $serverRequired = in_array($placement, ['server', 'required', 'optional-both'], true);
        $clientRequired = $placement !== 'server';
        if ($serverRequired && ($version['server_side'] ?? 'required') === 'unsupported') throw new \RuntimeException(($version['name'] ?? 'Mod') . ' cannot run on the server.');
        if ($clientRequired && ($version['client_side'] ?? 'required') === 'unsupported') throw new \RuntimeException(($version['name'] ?? 'Mod') . ' cannot run on clients.');
    }

    private function pathsFor(string $placement, string $filename, ?string $categoryFolder): array
    {
        return match ($placement) {
            'server' => ['mods/' . $filename],
            'required' => ['mods/' . $filename, 'impulse/mods/' . $filename],
            'client-required' => ['impulse/mods/' . $filename],
            'optional-both' => ['mods/' . $filename, 'impulse/optionnal_mods/' . $categoryFolder . '/' . $filename],
            'optional-client' => ['impulse/optionnal_mods/' . $categoryFolder . '/' . $filename],
            default => throw new \RuntimeException('Unknown install placement.'),
        };
    }

    private function assertNoDuplicateClientFilenames(array $plan): void
    {
        $files = [];
        foreach ($plan as $entry) foreach ($entry['paths'] as $path) if (str_starts_with($path, 'impulse/')) {
            $name = strtolower(basename($path));
            if (isset($files[$name]) && $files[$name] !== $entry['project_id']) throw new \RuntimeException('Two client mods would publish the same filename: ' . basename($path));
            $files[$name] = $entry['project_id'];
        }
    }

    private function verifyRemoteFile(ImpulseManagerService $manager, Server $server, string $path, array $file): void
    {
        $expectedSize = (int) ($file['size'] ?? 0);
        $content = $manager->repository($server)->getContent($path, $expectedSize > 0 ? $expectedSize + 1 : null);
        if ($expectedSize > 0 && $expectedSize !== strlen($content)) throw new \RuntimeException('Size verification failed for ' . $file['filename'] . '.');
        if (!hash_equals(strtolower($file['hashes']['sha1']), sha1($content))) throw new \RuntimeException('SHA-1 verification failed for ' . $file['filename'] . '.');
    }

    private function ensurePath(ImpulseManagerService $manager, Server $server, string $path): void { $manager->ensurePath($server, $path); }
    private function fileEntry(ImpulseManagerService $manager, Server $server, string $directory, string $name): ?array { foreach ($manager->entries($server, $directory) as $entry) if ($entry['name'] === $name && empty($entry['directory'])) return $entry; return null; }
    private function managedAtPath(array $state, string $path): ?array { foreach ($state['files'] as $entry) if (in_array($path, $entry['paths'] ?? [], true)) return $entry; return null; }
    private function isOwnedPath(array $entry, string $path): bool { return !array_key_exists('owned_paths', $entry) || in_array($path, $entry['owned_paths'] ?? [], true); }
    private function log(ImpulseOperation $operation, string $line): void { $logs = $operation->logs ?? []; $logs[] = '[' . now()->format('H:i:s') . '] ' . $line; $operation->update(['logs' => $logs]); }
}
