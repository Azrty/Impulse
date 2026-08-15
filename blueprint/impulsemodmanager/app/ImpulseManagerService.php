<?php

namespace Pterodactyl\BlueprintFramework\Extensions\impulsemodmanager;

use Illuminate\Support\Arr;
use Illuminate\Support\Str;
use Pterodactyl\Facades\Activity;
use Pterodactyl\Models\Permission;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\ServerVariable;
use Pterodactyl\Models\User;
use Pterodactyl\Repositories\Wings\DaemonFileRepository;
use Pterodactyl\Repositories\Wings\DaemonCommandRepository;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;

/**
 * Owns the extension's server-file conventions. All file writes stay within
 * mods/ or impulse/, and state records let us leave user-managed jars alone.
 */
class ImpulseManagerService
{
    public const STATE_FILE = 'impulse/.manager/state.json';
    public const PROPERTIES_FILE = 'config/impulse-server.properties';
    public const PUBLIC_INDEX_FILE = 'impulse/.manager/public-index.json';

    public function __construct(private DaemonFileRepository $files, private ModrinthClient $modrinth, private DaemonCommandRepository $commands)
    {
    }

    public function authorize(User $user, Server $server): void
    {
        if ($user->root_admin || $user->id === $server->owner_id) {
            return;
        }

        $subuser = $server->subusers()->where('user_id', $user->id)->first();
        $permissions = $subuser?->permissions ?? [];
        $needed = [
            Permission::ACTION_FILE_READ,
            Permission::ACTION_FILE_CREATE,
            Permission::ACTION_FILE_UPDATE,
            Permission::ACTION_FILE_DELETE,
        ];
        foreach ($needed as $permission) {
            if (!in_array($permission, $permissions, true)) {
                throw new AccessDeniedHttpException('Impulse Mod Manager requires file read, create, update, and delete permissions.');
            }
        }
    }

    public function authorizeStartupUpdate(User $user, Server $server): void
    {
        if ($user->root_admin || $user->id === $server->owner_id) {
            return;
        }

        $subuser = $server->subusers()->where('user_id', $user->id)->first();
        if (!in_array(Permission::ACTION_STARTUP_UPDATE, $subuser?->permissions ?? [], true)) {
            throw new AccessDeniedHttpException('Changing the Minecraft target requires the startup update permission.');
        }
    }

    public function repository(Server $server): DaemonFileRepository
    {
        return $this->files->setServer($server);
    }

    public function overview(Server $server): array
    {
        $this->ensureImpulseDirectories($server);
        $state = $this->hydrateManagedMetadata($server, $this->state($server));
        $runtime = $this->detectRuntime($server);
        $categories = $this->categories($server);
        [$state, $inventory] = $this->autoManageRecognizedJars($server, $state, $categories);
        $mods = $this->mods($server, $state, $categories, $runtime);
        $properties = $this->properties($server);

        return [
            'runtime' => $runtime,
            'impulse' => [
                'installed' => $this->hasImpulseJar($server),
                'configPath' => self::PROPERTIES_FILE,
                'manifestPaths' => ['impulse/mods', 'impulse/optionnal_mods', 'impulse/assets'],
                'properties' => $properties,
            ],
            'mods' => $mods,
            'inventory' => $inventory,
            'categories' => $categories,
            'assets' => $this->assets($server),
            'restartRequired' => (bool) ($state['restart_required'] ?? false),
            'operations' => ImpulseOperation::query()
                ->where('server_id', $server->id)
                ->latest('created_at')
                ->limit(20)
                ->get()
                ->map(fn (ImpulseOperation $operation) => $this->operationPayload($operation))
                ->values()
                ->all(),
            'relationships' => $this->relationships($server),
            'content' => $this->content($server),
        ];
    }

    public function detectRuntime(Server $server): array
    {
        $state = $this->state($server);
        $override = $state['runtime_override'] ?? null;
        if (is_array($override) && in_array($override['loader'] ?? null, ['forge', 'neoforge'], true) && !empty($override['minecraftVersion'])) {
            return [
                'minecraftVersion' => $override['minecraftVersion'],
                'loader' => $override['loader'],
                'confidence' => 'high',
                'sources' => ['Confirmed server target'],
                'override' => true,
                'needsSetup' => false,
            ];
        }

        $sources = [];
        $loaderCandidates = [];
        $versionCandidates = [];
        foreach ($server->variables()->get() as $variable) {
            $name = strtoupper((string) ($variable->env_variable ?? ''));
            $value = (string) ($variable->server_value ?? $variable->default_value ?? '');
            if ($value === '') continue;
            if (str_contains($name, 'NEOFORGE')) {
                $loaderCandidates[] = 'neoforge';
                $sources[] = 'egg variable ' . $name;
            } elseif (str_contains($name, 'FORGE')) {
                $loaderCandidates[] = 'forge';
                $sources[] = 'egg variable ' . $name;
            }
            if ($name === 'MC_VERSION' || str_contains($name, 'MINECRAFT_VERSION')) {
                $version = $this->minecraftVersionFrom($value);
                if ($version !== null) $versionCandidates[] = $version;
                $sources[] = 'egg variable ' . $name;
            }
        }

        $startup = (string) $server->startup;
        if (preg_match('/--fml\.mcVersion(?:=|\s+)(1\.\d+(?:\.\d+)?)/i', $startup, $match)) {
            $versionCandidates[] = $match[1];
            $sources[] = 'startup command';
        }
        if (stripos($startup, 'neoforge') !== false || stripos($startup, 'neoforged') !== false) {
            $loaderCandidates[] = 'neoforge';
            $sources[] = 'startup command';
        } elseif (stripos($startup, 'forge') !== false) {
            $loaderCandidates[] = 'forge';
            $sources[] = 'startup command';
        }

        foreach ([['libraries/net/neoforged/neoforge', 'neoforge'], ['libraries/net/minecraftforge/forge', 'forge']] as [$path, $loader]) {
            try {
                $entries = $this->entries($server, $path);
                if (count($entries) > 0) {
                    $loaderCandidates[] = $loader;
                    $sources[] = $path;
                }
                if ($loader === 'forge') {
                    foreach ($entries as $entry) {
                        if (preg_match('/^(1\.\d+(?:\.\d+)?)-/', (string) $entry['name'], $match)) {
                            $versionCandidates[] = $match[1];
                        }
                    }
                }
            } catch (\Throwable) {
                // Libraries are optional evidence; egg variables remain useful without them.
            }
        }

        $loaderValues = array_values(array_unique(array_filter($loaderCandidates)));
        $versionValues = array_values(array_unique(array_filter($versionCandidates)));
        $detected = count($loaderValues) === 1 && count($versionValues) === 1;

        return [
            'minecraftVersion' => count($versionValues) === 1 ? $versionValues[0] : null,
            'loader' => count($loaderValues) === 1 ? $loaderValues[0] : null,
            'confidence' => $detected
                ? (count($sources) > 1 ? 'high' : 'medium')
                : 'low',
            'sources' => array_values(array_unique($sources)),
            'override' => count($loaderValues) > 1 || count($versionValues) > 1,
            'needsSetup' => true,
        ];
    }

    public function ensureRuntime(array $runtime): void
    {
        if (!in_array($runtime['loader'] ?? null, ['forge', 'neoforge'], true) || empty($runtime['minecraftVersion'])) {
            throw new BadRequestHttpException('Impulse could not confidently detect this server\'s Minecraft version and loader. Set a manual override before installing mods.');
        }
    }

    public function saveRuntimeOverride(Server $server, User $user, ?string $minecraftVersion, ?string $loader): array
    {
        if (!preg_match('/^1\.\d+(?:\.\d+)?$/', (string) $minecraftVersion) || !in_array($loader, ['forge', 'neoforge'], true)) {
            throw new BadRequestHttpException('Enter a valid Minecraft version and choose Forge or NeoForge.');
        }

        $variable = $server->variables()->where('env_variable', 'MC_VERSION')->first();
        if ($variable === null) {
            throw new BadRequestHttpException('This egg does not define an MC_VERSION variable. Add it to the egg before configuring Impulse.');
        }
        if (!$user->root_admin && !$variable->user_editable) {
            throw new AccessDeniedHttpException('The MC_VERSION variable is read-only for this server. A panel administrator must configure it.');
        }

        validator(['value' => $minecraftVersion], ['value' => $variable->rules])->validate();
        $original = (string) ($variable->server_value ?? $variable->default_value ?? '');
        ServerVariable::query()->updateOrCreate(
            ['server_id' => $server->id, 'variable_id' => $variable->id],
            ['variable_value' => $minecraftVersion]
        );

        if ($original !== $minecraftVersion) {
            Activity::event('server:startup.edit')
                ->subject($variable)
                ->property(['variable' => 'MC_VERSION', 'old' => $original, 'new' => $minecraftVersion])
                ->log();
        }

        $state = $this->state($server);
        $state['runtime_override'] = ['minecraftVersion' => $minecraftVersion, 'loader' => $loader];
        $state['runtime_setup_complete'] = true;
        $this->saveState($server, $state);
        return $this->detectRuntime($server);
    }

    public function ensureImpulseDirectories(Server $server): void
    {
        foreach (['config', 'mods', 'impulse', 'impulse/mods', 'impulse/assets', 'impulse/optionnal_mods', 'impulse/.manager', 'impulse/.manager/staging', 'impulse/.manager/rollback'] as $directory) {
            $this->ensureDirectory($server, $directory);
        }
    }

    public function categories(Server $server): array
    {
        $categories = [];
        foreach ($this->entries($server, 'impulse/optionnal_mods') as $entry) {
            if (!$entry['directory']) continue;
            $folder = $entry['name'];
            if (!$this->safeSegment($folder)) continue;
            $config = $this->json($this->readIfExists($server, 'impulse/optionnal_mods/' . $folder . '/config.json'));
            $categories[] = $this->categoryPayload($folder, $config, $this->countJars($server, 'impulse/optionnal_mods/' . $folder));
        }
        usort($categories, fn ($left, $right) => [$left['order'], strtolower($left['name'])] <=> [$right['order'], strtolower($right['name'])]);
        return $categories;
    }

    public function createCategory(Server $server, array $input): array
    {
        $folder = trim((string) ($input['folder'] ?? ''));
        if (!$this->safeSegment($folder)) throw new BadRequestHttpException('Category folders may only use letters, numbers, hyphens, and underscores.');
        $directory = 'impulse/optionnal_mods/' . $folder;
        if ($this->directoryExists($server, $directory)) throw new BadRequestHttpException('That category folder already exists.');
        $this->ensureDirectory($server, $directory);
        return $this->writeCategory($server, $folder, $input, 0);
    }

    public function updateCategory(Server $server, string $category, array $input): array
    {
        $existing = $this->categoryById($server, $category);
        if ($existing === null) throw new BadRequestHttpException('Optional category not found.');
        $folder = trim((string) ($input['folder'] ?? $existing['folder']));
        if (!$this->safeSegment($folder)) throw new BadRequestHttpException('Category folders may only use letters, numbers, hyphens, and underscores.');
        if ($folder !== $existing['folder']) {
            if ($this->directoryExists($server, 'impulse/optionnal_mods/' . $folder)) throw new BadRequestHttpException('That category folder already exists.');
            $this->repository($server)->renameFiles('impulse/optionnal_mods', [['from' => $existing['folder'], 'to' => $folder]]);
        }
        return $this->writeCategory($server, $folder, array_merge($existing, $input), (int) $existing['modCount']);
    }

    public function deleteCategory(Server $server, string $category): void
    {
        $existing = $this->categoryById($server, $category);
        if ($existing === null) throw new BadRequestHttpException('Optional category not found.');
        if ($existing['modCount'] > 0) throw new BadRequestHttpException('Move or remove this category\'s mods before deleting it.');
        $this->repository($server)->deleteFiles('impulse/optionnal_mods', [$existing['folder']]);
    }

    public function properties(Server $server): array
    {
        return $this->parseProperties($this->readIfExists($server, self::PROPERTIES_FILE));
    }

    public function saveProperties(Server $server, array $properties): void
    {
        $allowed = [
            'manifest.version', 'public.host', 'manifest.port', 'server.name', 'server.description', 'server.autoConnect',
            'minecraft.version', 'minecraft.loader', 'minecraft.port', 'loader.version', 'forge.version',
            'mods.directory', 'optionalmods.directory', 'media.directory', 'mods.exclude', 'menu.enabled', 'menu.skin',
            'menu.title', 'menu.subtitle', 'menu.hideServerNameFromPlayButton', 'singleplayerenabled', 'multiplayerenabled',
            'media.iconFile', 'media.bannerFile', 'media.videoBackgroundFile',
            'media.iconUrl', 'media.bannerUrl', 'media.videoBackgroundUrl',
            'maintenance.enabled', 'maintenance.title', 'maintenance.message', 'maintenance.estimatedEnd',
        ];
        $updates = [];
        foreach ($properties as $key => $value) {
            if (in_array($key, $allowed, true)) $updates[$key] = str_replace(["\r", "\n"], '', (string) $value);
        }
        $this->repository($server)->putContent(self::PROPERTIES_FILE, $this->mergeProperties($this->readIfExists($server, self::PROPERTIES_FILE), $updates));
    }

    public function content(Server $server): array
    {
        $content = $this->json($this->readIfExists($server, 'impulse/content.json'));
        return [
            'announcements' => array_values($content['announcements'] ?? []),
            'changelog' => array_values($content['changelog'] ?? []),
            'events' => array_values($content['events'] ?? []),
        ];
    }

    public function saveContent(Server $server, array $content): array
    {
        $clean = ['announcements' => [], 'changelog' => [], 'events' => []];
        $seen = [];
        foreach (array_keys($clean) as $section) {
            foreach (array_values($content[$section] ?? []) as $entry) {
                $id = trim((string) ($entry['id'] ?? ''));
                if ($id === '' || isset($seen[$section . ':' . $id])) throw new BadRequestHttpException('Every ' . $section . ' entry needs a unique ID.');
                $seen[$section . ':' . $id] = true;
                $bodyFields = $section === 'changelog' ? ['body'] : ($section === 'announcements' ? ['body'] : ['description']);
                foreach ($bodyFields as $field) $entry[$field] = $this->safeMarkdown((string) ($entry[$field] ?? ''));
                foreach (['link', 'image'] as $field) if (!empty($entry[$field]) && !$this->safePublicUrl((string) $entry[$field])) throw new BadRequestHttpException('Unsafe ' . $field . ' URL in ' . $id . '.');
                $clean[$section][] = $entry;
            }
        }
        $this->repository($server)->putContent('impulse/content.json', json_encode($clean, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        return $clean;
    }

    public function reloadImpulse(Server $server): array
    {
        try {
            $this->commands->setServer($server)->send('impulse reload');
            return ['reloaded' => true, 'message' => 'Impulse reloaded on the running server.'];
        } catch (\Throwable) {
            return ['reloaded' => false, 'message' => 'Reload pending until next startup.'];
        }
    }

    private function safeMarkdown(string $value): string
    {
        if (preg_match('/<\/?[a-z][^>]*>/i', $value)) throw new BadRequestHttpException('Raw HTML is not allowed in Impulse content.');
        if (preg_match('/\]\s*\(\s*(?:javascript|data|vbscript):/i', $value)) throw new BadRequestHttpException('Unsafe Markdown URL scheme.');
        return trim($value);
    }

    private function safePublicUrl(string $value): bool
    {
        $scheme = strtolower((string) parse_url($value, PHP_URL_SCHEME));
        return in_array($scheme, ['http', 'https'], true);
    }

    public function assets(Server $server): array
    {
        return array_values(array_filter($this->entries($server, 'impulse/assets'), fn ($entry) => !$entry['directory'])) ;
    }

    public function state(Server $server): array
    {
        $state = $this->json($this->readIfExists($server, self::STATE_FILE));
        return array_merge(['files' => [], 'restart_required' => false], $state ?: []);
    }

    public function saveState(Server $server, array $state): void
    {
        $this->repository($server)->putContent(self::STATE_FILE, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        $this->writePublicIndex($server, $state);
    }

    public function relationships(Server $server): array
    {
        $state = $this->state($server);
        $mods = [];
        foreach ($state['files'] ?? [] as $file) {
            $id = (string) ($file['project_id'] ?? $file['id'] ?? '');
            if ($id === '') continue;
            $mods[] = [
                'id' => $id,
                'name' => $file['name'] ?? $id,
                'required' => in_array($file['placement'] ?? '', ['required', 'client-required'], true),
                'dependencies' => array_values(array_unique($file['dependencies'] ?? [])),
                'conflicts' => array_values(array_unique($file['conflicts'] ?? ($state['relationships']['conflicts'][$id] ?? []))),
                'update_policy' => $file['update_policy'] ?? 'release',
            ];
        }
        return ['mods' => $mods, 'errors' => $this->validateRelationshipGraph($mods, false)];
    }

    public function saveRelationships(Server $server, array $input): array
    {
        $state = $this->state($server);
        $filesById = [];
        foreach ($state['files'] ?? [] as $index => $file) {
            $id = (string) ($file['project_id'] ?? $file['id'] ?? '');
            if ($id !== '') $filesById[$id] = $index;
        }
        $conflicts = [];
        foreach (($input['conflicts'] ?? []) as $id => $targets) {
            if (!isset($filesById[$id])) throw new BadRequestHttpException('Unknown relationship mod ID: ' . $id);
            foreach (array_values(array_unique(array_filter((array) $targets))) as $target) {
                if ($target === $id || !isset($filesById[$target])) throw new BadRequestHttpException('Invalid conflict reference ' . $id . ' -> ' . $target . '.');
                $conflicts[$id][] = $target;
                $conflicts[$target][] = $id;
            }
        }
        foreach ($conflicts as $id => $targets) $conflicts[$id] = array_values(array_unique($targets));
        $policies = $input['policies'] ?? [];
        foreach ($filesById as $id => $index) {
            $state['files'][$index]['conflicts'] = $conflicts[$id] ?? [];
            if (isset($policies[$id])) {
                if (!in_array($policies[$id], ['pinned', 'release', 'beta', 'alpha'], true)) throw new BadRequestHttpException('Invalid update policy for ' . $id . '.');
                $state['files'][$index]['update_policy'] = $policies[$id];
            }
        }
        $mods = [];
        foreach ($state['files'] as $file) {
            $id = (string) ($file['project_id'] ?? $file['id'] ?? '');
            if ($id === '') continue;
            $mods[] = ['id' => $id, 'name' => $file['name'] ?? $id, 'required' => in_array($file['placement'] ?? '', ['required', 'client-required'], true), 'dependencies' => $file['dependencies'] ?? [], 'conflicts' => $file['conflicts'] ?? [], 'update_policy' => $file['update_policy'] ?? 'release'];
        }
        $errors = $this->validateRelationshipGraph($mods, true);
        if ($errors) throw new BadRequestHttpException(implode(' ', $errors));
        $state['relationships'] = ['conflicts' => $conflicts];
        $this->saveState($server, $state);
        return $this->relationships($server);
    }

    private function validateRelationshipGraph(array $mods, bool $strict): array
    {
        $byId = [];
        $errors = [];
        foreach ($mods as $mod) {
            if (isset($byId[$mod['id']])) $errors[] = 'Duplicate mod ID ' . $mod['id'] . '.';
            $byId[$mod['id']] = $mod;
        }
        foreach ($mods as $mod) {
            foreach ($mod['dependencies'] as $dependency) if (!isset($byId[$dependency])) $errors[] = $mod['name'] . ' references missing dependency ' . $dependency . '.';
            foreach ($mod['conflicts'] as $conflict) {
                if (!isset($byId[$conflict])) $errors[] = $mod['name'] . ' references missing conflict ' . $conflict . '.';
                elseif ($mod['required'] && ($byId[$conflict]['required'] ?? false)) $errors[] = 'Required mods ' . $mod['name'] . ' and ' . $byId[$conflict]['name'] . ' cannot conflict.';
            }
        }
        $visiting = [];
        $visited = [];
        $walk = function (string $id) use (&$walk, &$visiting, &$visited, &$errors, $byId) {
            if (isset($visiting[$id])) { $errors[] = 'Dependency cycle detected at ' . $id . '.'; return; }
            if (isset($visited[$id]) || !isset($byId[$id])) return;
            $visiting[$id] = true;
            foreach ($byId[$id]['dependencies'] as $dependency) $walk($dependency);
            unset($visiting[$id]);
            $visited[$id] = true;
        };
        foreach (array_keys($byId) as $id) $walk($id);
        return array_values(array_unique($errors));
    }

    private function writePublicIndex(Server $server, array $state): void
    {
        $mods = [];
        foreach ($state['files'] ?? [] as $file) {
            $sha1 = strtolower((string) ($file['sha1'] ?? ''));
            if (!preg_match('/^[a-f0-9]{40}$/', $sha1)) continue;
            $mods[$sha1] = [
                'id' => (string) ($file['project_id'] ?? $file['id'] ?? $sha1),
                'project_id' => $file['project_id'] ?? null,
                'version_id' => $file['version_id'] ?? null,
                'dependencies' => array_values(array_unique($file['dependencies'] ?? [])),
                'conflicts' => array_values(array_unique($file['conflicts'] ?? [])),
            ];
        }
        $this->repository($server)->putContent(self::PUBLIC_INDEX_FILE, json_encode(['version' => 1, 'mods' => $mods], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    }

    public function clearRestartRequired(Server $server): void
    {
        $state = $this->state($server);
        $state['restart_required'] = false;
        $this->saveState($server, $state);
    }

    public function operationPayload(ImpulseOperation $operation): array
    {
        return [
            'id' => $operation->id,
            'state' => $operation->state,
            'summary' => $operation->summary,
            'logs' => $operation->logs ?? [],
            'createdAt' => optional($operation->created_at)->toIso8601String(),
        ];
    }

    public function entries(Server $server, string $directory): array
    {
        $raw = $this->repository($server)->getDirectory($directory);
        return array_map(function (array $entry) {
            $attributes = $entry['attributes'] ?? $entry;
            $isFile = array_key_exists('is_file', $attributes)
                ? (bool) $attributes['is_file']
                : (array_key_exists('file', $attributes) ? (bool) $attributes['file'] : null);
            $mime = (string) ($attributes['mimetype'] ?? $attributes['mime'] ?? '');
            return [
                'name' => (string) ($attributes['name'] ?? ''),
                'directory' => $isFile === false || $mime === 'inode/directory',
                'size' => (int) ($attributes['size'] ?? 0),
                'modifiedAt' => (string) ($attributes['modified_at'] ?? $attributes['modifiedAt'] ?? ''),
            ];
        }, $raw);
    }

    public function managedFile(Server $server, string $key): ?array
    {
        foreach ($this->state($server)['files'] as $file) if (($file['key'] ?? '') === $key) return $file;
        return null;
    }

    public function removeStateFile(Server $server, string $key): array
    {
        $state = $this->state($server);
        $removed = null;
        $state['files'] = array_values(array_filter($state['files'], function ($file) use ($key, &$removed) {
            if (($file['key'] ?? '') !== $key) return true;
            $removed = $file;
            return false;
        }));
        if ($removed === null) throw new BadRequestHttpException('This jar is not managed by Impulse Mod Manager.');
        $this->saveState($server, $state);
        return $removed;
    }

    private function mods(Server $server, array $state, array $categories, array $runtime): array
    {
        $allPaths = [];
        $pathModified = [];
        foreach (['mods', 'impulse/mods', 'impulse/optionnal_mods'] as $root) {
            foreach ($this->recursiveJarEntries($server, $root) as $entry) {
                $allPaths[$entry['path']] = $entry['size'];
                $pathModified[$entry['path']] = $entry['modifiedAt'] ?? '';
            }
        }
        $metadataCache = $this->json($this->readIfExists($server, 'impulse/.manager/jar-metadata.json'));
        $metadataChanged = false;

        $out = [];
        foreach ($state['files'] as $entry) {
            $existingPaths = array_values(array_filter($entry['paths'] ?? [], fn ($path) => isset($allPaths[$path])));
            if (count($existingPaths) === 0) continue;
            $metadata = $this->jarMetadata($server, $existingPaths[0], (int) ($allPaths[$existingPaths[0]] ?? 0), $metadataCache, $metadataChanged, $pathModified[$existingPaths[0]] ?? '');
            foreach ($existingPaths as $path) unset($allPaths[$path]);
            $out[] = [
                'key' => $entry['key'] ?? ('managed:' . sha1(implode('|', $existingPaths))),
                'name' => $metadata['name'] ?? $entry['name'] ?? pathinfo((string) ($entry['filename'] ?? $existingPaths[0]), PATHINFO_FILENAME),
                'description' => $metadata['description'] ?? $entry['description'] ?? '',
                'filename' => $entry['filename'] ?? basename($existingPaths[0]),
                'version' => $entry['version'] ?? null,
                'placement' => $entry['placement'] ?? 'Managed mod',
                'categoryId' => $entry['category_id'] ?? $this->categoryForPath($existingPaths[0], $categories),
                'managed' => true,
                'externallyOwned' => array_key_exists('owned_paths', $entry) && count(array_intersect($existingPaths, $entry['owned_paths'] ?? [])) < count($existingPaths),
                'update' => $this->updateFor($entry, $runtime),
            ];
        }

        $localGroups = [];
        foreach (array_keys($allPaths) as $path) {
            $metadata = $this->jarMetadata($server, $path, (int) ($allPaths[$path] ?? 0), $metadataCache, $metadataChanged, $pathModified[$path] ?? '');
            $groupKey = !empty($metadata['sha1']) ? strtolower($metadata['sha1']) : 'path:' . $path;
            $localGroups[$groupKey]['paths'][] = $path;
            $localGroups[$groupKey]['metadata'] = array_merge($localGroups[$groupKey]['metadata'] ?? [], $metadata);
        }
        foreach ($localGroups as $group) {
            $paths = $group['paths'];
            $path = $paths[0];
            $metadata = $group['metadata'];
            $out[] = [
                'key' => 'local:' . sha1(implode('|', $paths)),
                'name' => $metadata['name'] ?? pathinfo($path, PATHINFO_FILENAME),
                'description' => $metadata['description'] ?? '',
                'filename' => basename($path),
                'version' => $metadata['version'] ?? null,
                'placement' => $this->localPlacement($paths),
                'categoryId' => $this->categoryForPath($path, $categories),
                'managed' => false,
                'externallyOwned' => true,
                'update' => null,
            ];
        }
        if ($metadataChanged) {
            $this->repository($server)->putContent('impulse/.manager/jar-metadata.json', json_encode($metadataCache, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        }
        usort($out, fn ($left, $right) => strtolower($left['name']) <=> strtolower($right['name']));
        return $out;
    }

    private function autoManageRecognizedJars(Server $server, array $state, array $categories): array
    {
        $allPaths = [];
        $pathModified = [];
        foreach (['mods', 'impulse/mods', 'impulse/optionnal_mods'] as $root) {
            foreach ($this->recursiveJarEntries($server, $root) as $entry) {
                $allPaths[$entry['path']] = $entry['size'];
                $pathModified[$entry['path']] = $entry['modifiedAt'] ?? '';
            }
        }
        $metadataCache = $this->json($this->readIfExists($server, 'impulse/.manager/jar-metadata.json'));
        $metadataChanged = false;
        $groups = [];
        $lookupHashes = [];
        $now = time();

        foreach ($allPaths as $path => $size) {
            $metadata = $this->jarMetadata($server, $path, (int) $size, $metadataCache, $metadataChanged, $pathModified[$path] ?? '');
            $hash = strtolower((string) ($metadata['sha1'] ?? ''));
            if (!preg_match('/^[a-f0-9]{40}$/', $hash)) continue;
            $groups[$hash]['paths'][] = $path;
            $groups[$hash]['metadata'] = array_merge($groups[$hash]['metadata'] ?? [], $metadata);
            if (empty($metadata['project_id']) && ($now - (int) ($metadata['lookup_checked_at'] ?? 0)) >= 21600) $lookupHashes[] = $hash;
        }

        $stateByHash = [];
        foreach ($state['files'] ?? [] as $file) {
            $hash = strtolower((string) ($file['sha1'] ?? ''));
            if (preg_match('/^[a-f0-9]{40}$/', $hash)) $stateByHash[$hash] = $file;
        }
        foreach ($groups as $hash => &$group) {
            $known = $stateByHash[$hash] ?? null;
            if (!$known) continue;
            $group['metadata'] = array_merge($group['metadata'], [
                'project_id' => $known['project_id'] ?? $group['metadata']['project_id'] ?? null,
                'version_id' => $known['version_id'] ?? $group['metadata']['version_id'] ?? null,
                'version' => $known['version'] ?? $group['metadata']['version'] ?? null,
                'project_name' => $known['name'] ?? $group['metadata']['project_name'] ?? null,
                'project_description' => $known['description'] ?? $group['metadata']['project_description'] ?? '',
                'resolved_dependencies' => $known['dependencies'] ?? $group['metadata']['resolved_dependencies'] ?? null,
            ]);
        }
        unset($group);
        $lookupHashes = array_values(array_filter(array_unique($lookupHashes), fn ($hash) => empty($groups[$hash]['metadata']['project_id'])));

        $versions = [];
        try {
            $versions = $this->modrinth->versionsFromHashes($lookupHashes);
        } catch (\Throwable) {
            // Inventory remains available from jar metadata while Modrinth is unavailable.
        }
        foreach ($groups as $hash => &$group) {
            $version = $versions[$hash] ?? null;
            if ($version) {
                $group['metadata'] = array_merge($group['metadata'], [
                    'project_id' => $version['project_id'] ?? null,
                    'version_id' => $version['id'] ?? null,
                    'version' => $version['version_number'] ?? $version['name'] ?? null,
                    'dependencies' => $version['dependencies'] ?? [],
                    'lookup_checked_at' => $now,
                ]);
            } elseif (in_array($hash, $lookupHashes, true)) {
                $group['metadata']['lookup_checked_at'] = $now;
            }
        }
        unset($group);

        $projectIds = [];
        foreach ($groups as $group) if (!empty($group['metadata']['project_id']) && empty($group['metadata']['project_name'])) $projectIds[] = $group['metadata']['project_id'];
        $projects = [];
        try {
            $projects = $this->modrinth->projects($projectIds);
        } catch (\Throwable) {
            // Embedded metadata remains the display fallback.
        }

        foreach ($groups as &$group) {
            $project = $projects[$group['metadata']['project_id'] ?? ''] ?? null;
            if ($project) {
                $group['metadata']['project_name'] = $project['title'] ?? null;
                $group['metadata']['project_description'] = $project['description'] ?? '';
            }
            sort($group['paths']);
            foreach ($group['paths'] as $path) {
                $cacheEntry = [
                    'size' => (int) ($allPaths[$path] ?? 0),
                    'modifiedAt' => $pathModified[$path] ?? '',
                    'schema' => 3,
                    'metadata' => $group['metadata'],
                ];
                if (($metadataCache[$path] ?? null) !== $cacheEntry) {
                    $metadataCache[$path] = $cacheEntry;
                    $metadataChanged = true;
                }
            }
        }
        unset($group);
        if ($metadataChanged) $this->repository($server)->putContent('impulse/.manager/jar-metadata.json', json_encode($metadataCache, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");

        $deduplicatedFiles = [];
        $deduplicatedByHash = [];
        foreach ($state['files'] ?? [] as $file) {
            $hash = strtolower((string) ($file['sha1'] ?? ''));
            if ($hash !== '' && isset($deduplicatedByHash[$hash])) {
                $index = $deduplicatedByHash[$hash];
                $deduplicatedFiles[$index]['paths'] = array_values(array_unique(array_merge($deduplicatedFiles[$index]['paths'] ?? [], $file['paths'] ?? [])));
                $deduplicatedFiles[$index]['owned_paths'] = array_values(array_unique(array_merge($deduplicatedFiles[$index]['owned_paths'] ?? [], $file['owned_paths'] ?? [])));
                $deduplicatedFiles[$index]['conflicts'] = array_values(array_unique(array_merge($deduplicatedFiles[$index]['conflicts'] ?? [], $file['conflicts'] ?? [])));
                continue;
            }
            $deduplicatedFiles[] = $file;
            if ($hash !== '') $deduplicatedByHash[$hash] = array_key_last($deduplicatedFiles);
        }
        $state['files'] = $deduplicatedFiles;
        $existingByHash = $deduplicatedByHash;
        $recognized = 0;
        foreach ($groups as $hash => $group) {
            $metadata = $group['metadata'];
            $projectId = (string) ($metadata['project_id'] ?? '');
            if ($projectId === '') continue;
            $recognized++;
            $existingIndex = $existingByHash[$hash] ?? null;
            $existing = $existingIndex !== null ? $state['files'][$existingIndex] : null;
            $placement = $this->placementForPaths($group['paths']);
            $existingOwnedPaths = $existing
                ? (array_key_exists('owned_paths', $existing) ? ($existing['owned_paths'] ?? []) : ($existing['paths'] ?? []))
                : [];
            $entry = [
                'key' => $existing['key'] ?? ($projectId . ':' . ($metadata['version_id'] ?? 'local') . ':' . substr($hash, 0, 8)),
                'project_id' => $projectId,
                'version_id' => $metadata['version_id'] ?? null,
                'name' => $metadata['project_name'] ?? $metadata['name'] ?? basename($group['paths'][0]),
                'description' => $metadata['project_description'] ?? $metadata['description'] ?? '',
                'version' => $metadata['version'] ?? '',
                'sha1' => $hash,
                'filename' => basename($group['paths'][0]),
                'placement' => $existing['placement'] ?? $placement,
                'category_id' => $existing['category_id'] ?? $this->categoryForPaths($group['paths'], $categories),
                'paths' => $group['paths'],
                'owned_paths' => array_values(array_intersect($group['paths'], $existingOwnedPaths)),
                'source' => 'modrinth',
                'auto_imported' => $existing['auto_imported'] ?? true,
                'dependencies' => is_array($metadata['resolved_dependencies'] ?? null)
                    ? array_values(array_unique($metadata['resolved_dependencies']))
                    : $this->requiredDependencyProjectIds($metadata['dependencies'] ?? []),
                'dependencies_hydrated' => true,
                'dependencies_schema' => 2,
                'metadata_hydrated' => true,
                'metadata_schema' => 2,
                'conflicts' => $existing['conflicts'] ?? ($state['relationships']['conflicts'][$projectId] ?? []),
                'update_policy' => $existing['update_policy'] ?? 'release',
            ];
            if ($existingIndex !== null) $state['files'][$existingIndex] = array_merge($existing, $entry);
            else {
                $state['files'][] = $entry;
                $existingByHash[$hash] = array_key_last($state['files']);
            }
        }
        $before = json_encode($this->state($server)['files'] ?? []);
        $after = json_encode($state['files'] ?? []);
        if ($before !== $after) $this->saveState($server, $state);
        return [$state, ['total' => count($groups), 'recognized' => $recognized, 'local' => count($groups) - $recognized]];
    }

    private function placementForPaths(array $paths): string
    {
        $server = count(array_filter($paths, fn ($path) => str_starts_with($path, 'mods/'))) > 0;
        $required = count(array_filter($paths, fn ($path) => str_starts_with($path, 'impulse/mods/'))) > 0;
        $optional = count(array_filter($paths, fn ($path) => str_starts_with($path, 'impulse/optionnal_mods/'))) > 0;
        if ($server && $required) return 'required';
        if ($server && $optional) return 'optional-both';
        if ($optional) return 'optional-client';
        if ($required) return 'client-required';
        return 'server';
    }

    private function categoryForPaths(array $paths, array $categories): ?string
    {
        foreach ($paths as $path) {
            $category = $this->categoryForPath($path, $categories);
            if ($category !== null) return $category;
        }
        return null;
    }

    private function hydrateManagedMetadata(Server $server, array $state): array
    {
        $changed = false;
        foreach ($state['files'] ?? [] as $index => $file) {
            if (($file['source'] ?? '') !== 'modrinth' || empty($file['project_id'])) continue;
            try {
                if ((int) ($file['metadata_schema'] ?? 0) < 2) {
                    $project = $this->modrinth->project($file['project_id']);
                    if (!empty($project['title'])) $state['files'][$index]['name'] = $project['title'];
                    if (isset($project['description'])) $state['files'][$index]['description'] = (string) $project['description'];
                    $state['files'][$index]['metadata_hydrated'] = true;
                    $state['files'][$index]['metadata_schema'] = 2;
                    $changed = true;
                }
                if ((int) ($file['dependencies_schema'] ?? 0) < 2 && !empty($file['version_id'])) {
                    $version = $this->modrinth->version($file['version_id']);
                    $state['files'][$index]['dependencies'] = $this->requiredDependencyProjectIds($version['dependencies'] ?? []);
                    $state['files'][$index]['dependencies_hydrated'] = true;
                    $state['files'][$index]['dependencies_schema'] = 2;
                    $changed = true;
                }
            } catch (\Throwable) {
                // Modrinth outages should not prevent the manager from listing local files.
            }
        }
        if ($changed) $this->saveState($server, $state);
        return $state;
    }

    private function requiredDependencyProjectIds(array $dependencies): array
    {
        $projectIds = [];
        foreach ($dependencies as $dependency) {
            if (($dependency['dependency_type'] ?? '') !== 'required') continue;
            $projectId = $dependency['project_id'] ?? null;
            if (!$projectId && !empty($dependency['version_id'])) {
                try {
                    $dependencyVersion = $this->modrinth->version($dependency['version_id']);
                    $projectId = $dependencyVersion['project_id'] ?? null;
                } catch (\Throwable) {
                    $projectId = null;
                }
            }
            if (is_string($projectId) && $projectId !== '') $projectIds[] = $projectId;
        }
        return array_values(array_unique($projectIds));
    }

    private function jarMetadata(Server $server, string $path, int $size, array &$cache, bool &$changed, ?string $modifiedAt = null): array
    {
        $cached = $cache[$path] ?? null;
        $modifiedMatches = $modifiedAt === null || (string) ($cached['modifiedAt'] ?? '') === $modifiedAt;
        if (is_array($cached) && (int) ($cached['size'] ?? -1) === $size && (int) ($cached['schema'] ?? 0) >= 3 && $modifiedMatches) return $cached['metadata'] ?? [];
        $metadata = array_merge(is_array($cached['metadata'] ?? null) ? $cached['metadata'] : [], $this->readJarMetadata($server, $path, $size));
        $cache[$path] = ['size' => $size, 'modifiedAt' => $modifiedAt ?? (string) ($cached['modifiedAt'] ?? ''), 'schema' => 3, 'metadata' => $metadata];
        $changed = true;
        return $metadata;
    }

    public function inspectJar(Server $server, string $path, int $size): array
    {
        $metadata = $this->readJarMetadata($server, $path, $size);
        if (empty($metadata['sha1'])) return $metadata;
        try {
            $version = $this->modrinth->versionFromHash($metadata['sha1']);
            if ($version) {
                $metadata['project_id'] = $version['project_id'] ?? null;
                $metadata['version_id'] = $version['id'] ?? null;
                $metadata['version'] = $version['version_number'] ?? $version['name'] ?? null;
                if (!empty($version['project_id'])) {
                    $project = $this->modrinth->project($version['project_id']);
                    if (empty($metadata['name']) && !empty($project['title'])) $metadata['name'] = $project['title'];
                    if (empty($metadata['description']) && isset($project['description'])) $metadata['description'] = (string) $project['description'];
                }
            }
        } catch (\Throwable) {
            // Local metadata and SHA-1 remain useful while Modrinth is unavailable.
        }
        return $metadata;
    }

    private function readJarMetadata(Server $server, string $path, int $size): array
    {
        $temporary = tempnam(sys_get_temp_dir(), 'impulse-jar-');
        if ($temporary === false) return [];
        try {
            $content = $this->repository($server)->getContent($path, $size > 0 ? $size + 1 : 268435456);
            $metadata = ['sha1' => sha1($content)];
            if (!class_exists(\ZipArchive::class)) return $metadata;
            if (file_put_contents($temporary, $content) === false) return [];
            $zip = new \ZipArchive();
            if ($zip->open($temporary) !== true) return $metadata;
            try {
                foreach (['META-INF/neoforge.mods.toml', 'META-INF/mods.toml'] as $entry) {
                    $toml = $zip->getFromName($entry);
                    if (!is_string($toml)) continue;
                    $name = $this->tomlValue($toml, 'displayName');
                    $description = $this->tomlValue($toml, 'description');
                    if ($name !== '') return array_merge($metadata, ['name' => $name, 'description' => $description]);
                }
                $legacy = $zip->getFromName('mcmod.info');
                if (is_string($legacy)) {
                    $decoded = json_decode($legacy, true);
                    $entry = is_array($decoded) && array_is_list($decoded) ? ($decoded[0] ?? []) : $decoded;
                    if (is_array($entry)) {
                        $name = $this->cleanMetadataText((string) ($entry['name'] ?? $entry['modid'] ?? ''));
                        if ($name !== '') return array_merge($metadata, ['name' => $name, 'description' => $this->cleanMetadataText((string) ($entry['description'] ?? ''))]);
                    }
                }
                $pack = $zip->getFromName('pack.mcmeta');
                if (is_string($pack)) {
                    $decoded = json_decode($pack, true);
                    $description = $decoded['pack']['description'] ?? '';
                    if (is_string($description) && trim($description) !== '') return array_merge($metadata, ['description' => $this->cleanMetadataText($description)]);
                }
            } finally {
                $zip->close();
            }
            return $metadata;
        } catch (\Throwable) {
            return [];
        } finally {
            @unlink($temporary);
        }
        return [];
    }

    private function tomlValue(string $content, string $key): string
    {
        if (!preg_match('/^\s*' . preg_quote($key, '/') . '\s*=\s*(?:"""([\s\S]*?)"""|"((?:\\\\.|[^"\\\\])*)")/mi', $content, $match)) return '';
        return $this->cleanMetadataText(stripCSlashes($match[1] !== '' ? $match[1] : ($match[2] ?? '')));
    }

    private function cleanMetadataText(string $value): string
    {
        $clean = trim((string) preg_replace('/\s+/', ' ', preg_replace('/§[0-9A-FK-OR]/i', '', $value)));
        return preg_match('/^\$\{[^}]+\}$/', $clean) ? '' : $clean;
    }

    private function hasImpulseJar(Server $server): bool
    {
        try {
            foreach ($this->entries($server, 'mods') as $entry) {
                if (str_contains(strtolower($entry['name']), 'impulse') && str_ends_with(strtolower($entry['name']), '.jar')) return true;
            }
        } catch (\Throwable) {
            return false;
        }
        return false;
    }

    private function updateFor(array $entry, array $runtime): ?array
    {
        $policy = $entry['update_policy'] ?? 'release';
        if ($policy === 'pinned') return null;
        if (($entry['source'] ?? '') !== 'modrinth' || empty($entry['project_id']) || empty($runtime['loader']) || empty($runtime['minecraftVersion'])) return null;
        try {
            $versions = $this->modrinth->versions($entry['project_id'], $runtime['minecraftVersion'], $runtime['loader']);
            $allowed = match ($policy) {
                'alpha' => ['release', 'beta', 'alpha'],
                'beta' => ['release', 'beta'],
                default => ['release'],
            };
            $latest = collect($versions)->first(fn ($version) => in_array($version['version_type'] ?? 'release', $allowed, true));
            if ($latest && ($latest['id'] ?? '') !== ($entry['version_id'] ?? '')) return ['version' => $latest['version_number'] ?? 'New version'];
        } catch (\Throwable) {
            // An update check should never prevent routine file management.
        }
        return null;
    }

    public function categoryById(Server $server, string $id): ?array
    {
        foreach ($this->categories($server) as $category) if ($category['id'] === $id) return $category;
        return null;
    }

    private function categoryPayload(string $folder, array $input, int $modCount): array
    {
        return [
            'id' => $this->categoryId((string) ($input['id'] ?? $folder)),
            'folder' => $folder,
            'name' => trim((string) ($input['name'] ?? $folder)) ?: $folder,
            'description' => trim((string) ($input['description'] ?? '')),
            'default_enabled' => filter_var($input['default_enabled'] ?? false, FILTER_VALIDATE_BOOLEAN),
            'order' => (int) ($input['order'] ?? 0),
            'modCount' => $modCount,
        ];
    }

    private function writeCategory(Server $server, string $folder, array $input, int $modCount): array
    {
        $category = $this->categoryPayload($folder, $input, $modCount);
        $config = Arr::only($category, ['id', 'name', 'description', 'default_enabled', 'order']);
        $this->repository($server)->putContent('impulse/optionnal_mods/' . $folder . '/config.json', json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        return $category;
    }

    private function recursiveJars(Server $server, string $path): array
    {
        $out = [];
        try {
            foreach ($this->entries($server, $path) as $entry) {
                $child = $path . '/' . $entry['name'];
                if ($entry['directory']) $out = array_merge($out, $this->recursiveJars($server, $child));
                elseif (str_ends_with(strtolower($entry['name']), '.jar')) $out[] = $child;
            }
        } catch (\Throwable) {
            return [];
        }
        return $out;
    }

    private function recursiveJarEntries(Server $server, string $path): array
    {
        $out = [];
        try {
            foreach ($this->entries($server, $path) as $entry) {
                $child = $path . '/' . $entry['name'];
                if ($entry['directory']) $out = array_merge($out, $this->recursiveJarEntries($server, $child));
                elseif (str_ends_with(strtolower($entry['name']), '.jar')) $out[] = ['path' => $child, 'size' => (int) $entry['size'], 'modifiedAt' => $entry['modifiedAt'] ?? ''];
            }
        } catch (\Throwable) {
            return [];
        }
        return $out;
    }

    private function countJars(Server $server, string $path): int { return count($this->recursiveJars($server, $path)); }
    private function localPlacement(array $paths): string
    {
        $hasServer = false;
        $hasRequiredClient = false;
        $hasOptionalClient = false;
        foreach ($paths as $path) {
            $hasServer = $hasServer || str_starts_with($path, 'mods/');
            $hasRequiredClient = $hasRequiredClient || str_starts_with($path, 'impulse/mods/');
            $hasOptionalClient = $hasOptionalClient || str_starts_with($path, 'impulse/optionnal_mods/');
        }
        if ($hasServer && $hasRequiredClient) return 'Server + required client';
        if ($hasServer && $hasOptionalClient) return 'Server + optional client';
        if ($hasServer) return 'Server only';
        return $hasOptionalClient ? 'Optional client' : 'Required client';
    }
    private function categoryForPath(string $path, array $categories): ?string { foreach ($categories as $category) if (str_starts_with($path, 'impulse/optionnal_mods/' . $category['folder'] . '/')) return $category['id']; return null; }
    public function ensurePath(Server $server, string $path): void { $this->ensureDirectory($server, $path); }
    private function directoryExists(Server $server, string $path): bool { try { $this->entries($server, $path); return true; } catch (\Throwable) { return false; } }
    private function ensureDirectory(Server $server, string $path): void { if ($this->directoryExists($server, $path)) return; $parent = dirname($path); if ($parent !== '.' && $parent !== '/') $this->ensureDirectory($server, $parent); $this->repository($server)->createDirectory(basename($path), $parent === '.' ? '/' : $parent); }
    private function readIfExists(Server $server, string $path): string
    {
        try {
            $directory = dirname($path);
            $name = basename($path);
            foreach ($this->entries($server, $directory === '.' ? '/' : $directory) as $entry) {
                if ($entry['name'] === $name && !$entry['directory']) return $this->repository($server)->getContent($path, 1024 * 1024);
            }
        } catch (\Throwable) {
            // Missing config/state files are normal for a first visit.
        }
        return '';
    }
    private function json(string $content): array { $decoded = json_decode($content, true); return is_array($decoded) ? $decoded : []; }
    private function categoryId(string $value): string { $value = strtolower(preg_replace('/[^a-z0-9_-]+/i', '-', trim($value))); return trim($value, '-') ?: 'category'; }
    private function safeSegment(string $value): bool { return (bool) preg_match('/^[A-Za-z0-9_-]+$/', $value); }
    private function minecraftVersionFrom(string $value): ?string { return preg_match('/\b(1\.\d+(?:\.\d+)?)\b/', $value, $match) ? $match[1] : null; }

    private function parseProperties(string $content): array
    {
        $out = [];
        foreach (preg_split('/\R/', $content) as $line) if (preg_match('/^\s*([^#!\s][^=:#]*?)\s*[=:]\s*(.*)$/', $line, $match)) $out[trim($match[1])] = trim($match[2]);
        return $out;
    }

    private function mergeProperties(string $existing, array $updates): string
    {
        $seen = [];
        $lines = preg_split('/\R/', $existing);
        foreach ($lines as &$line) {
            if (!preg_match('/^(\s*)([^#!\s][^=:#]*?)(\s*[=:]\s*)(.*)$/', $line, $match)) continue;
            $key = trim($match[2]);
            if (!array_key_exists($key, $updates)) continue;
            $line = $match[1] . $key . '=' . $updates[$key];
            $seen[$key] = true;
        }
        unset($line);
        foreach ($updates as $key => $value) if (!isset($seen[$key])) $lines[] = $key . '=' . $value;
        return rtrim(implode("\n", $lines)) . "\n";
    }
}
