<?php

namespace Pterodactyl\BlueprintFramework\Extensions\impulsemodmanager;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Pterodactyl\Http\Controllers\Api\Client\ClientApiController;
use Pterodactyl\Models\Server;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;

class ImpulseManagerController extends ClientApiController
{
    public function __construct(private ImpulseManagerService $manager, private ModrinthClient $modrinth)
    {
        parent::__construct();
    }

    public function overview(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        // A first inventory pass must stream and hash every uncached jar from
        // Wings. Large modpacks can legitimately take longer than PHP's usual
        // request limit; subsequent loads use the persisted metadata cache.
        if (function_exists('set_time_limit')) @set_time_limit(300);
        return new JsonResponse($this->manager->overview($server));
    }

    public function saveRuntimeOverride(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $this->manager->authorizeStartupUpdate($request->user(), $server);
        $input = $request->validate([
            'minecraftVersion' => ['required', 'string', 'max:20'],
            'loader' => ['required', 'in:forge,neoforge'],
        ]);
        return new JsonResponse($this->manager->saveRuntimeOverride($server, $request->user(), $input['minecraftVersion'], $input['loader']));
    }

    public function searchModrinth(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $runtime = $this->manager->detectRuntime($server);
        $this->manager->ensureRuntime($runtime);
        $query = trim((string) $request->query('query'));
        if ($query === '') throw new BadRequestHttpException('Enter a Modrinth search query.');
        return new JsonResponse($this->modrinth->search($query, $runtime['minecraftVersion'], $runtime['loader']));
    }

    public function projectVersions(Request $request, Server $server, string $project): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $runtime = $this->manager->detectRuntime($server);
        $this->manager->ensureRuntime($runtime);
        return new JsonResponse(['versions' => $this->modrinth->versions($project, $runtime['minecraftVersion'], $runtime['loader'])]);
    }

    public function projectDetails(Request $request, Server $server, string $project): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $details = $this->modrinth->project($project);
        $details['authors'] = !empty($details['team']) ? $this->modrinth->team($details['team']) : [];
        return new JsonResponse(['project' => $details]);
    }

    public function createOperation(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $runtime = $this->manager->detectRuntime($server);
        $this->manager->ensureRuntime($runtime);
        $request->validate([
            'projectId' => ['required', 'string', 'max:128'],
            'projectName' => ['nullable', 'string', 'max:100'],
            'versionId' => ['required', 'string', 'max:128'],
            'placement' => ['required', 'in:server,required,client-required,optional-both,optional-client'],
            'categoryId' => ['nullable', 'string', 'max:100'],
            'allowConflicts' => ['nullable', 'boolean'],
            'updatePolicy' => ['nullable', 'in:pinned,release,beta,alpha'],
            'takeOwnership' => ['nullable', 'boolean'],
        ]);
        $placement = $request->string('placement')->toString();
        $categoryId = $request->input('categoryId');
        if (str_starts_with($placement, 'optional')) {
            if (!$categoryId || !$this->manager->categoryById($server, (string) $categoryId)) {
                throw new BadRequestHttpException('Choose a valid optional-mod category.');
            }
        }

        $operation = ImpulseOperation::create([
            'id' => (string) Str::uuid(),
            'server_id' => $server->id,
            'actor_id' => $request->user()->id,
            'state' => 'queued',
            'summary' => 'Installing ' . ($request->input('projectName') ?: $request->input('projectId')),
            'payload' => [
                'type' => 'install',
                'project_id' => $request->input('projectId'),
                'version_id' => $request->input('versionId'),
                'placement' => $placement,
                'category_id' => $categoryId,
                'runtime' => $runtime,
                'allow_conflicts' => (bool) $request->boolean('allowConflicts'),
                'update_policy' => $request->input('updatePolicy', 'release'),
                'take_ownership' => (bool) $request->boolean('takeOwnership'),
            ],
            'logs' => ['Queued. The files will be applied without restarting the server.'],
        ]);
        ApplyImpulseOperation::dispatch($operation->id);
        return new JsonResponse(['operation' => $this->manager->operationPayload($operation), 'message' => 'Operation queued and will apply immediately.'], 202);
    }

    public function previewOperation(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $runtime = $this->manager->detectRuntime($server);
        $this->manager->ensureRuntime($runtime);
        $input = $request->validate([
            'projectId' => ['required', 'string', 'max:128'],
            'versionId' => ['required', 'string', 'max:128'],
            'placement' => ['required', 'in:server,required,optional-both,optional-client'],
            'categoryId' => ['nullable', 'string', 'max:100'],
            'allowConflicts' => ['nullable', 'boolean'],
        ]);
        if (str_starts_with($input['placement'], 'optional') && (!$input['categoryId'] || !$this->manager->categoryById($server, $input['categoryId']))) {
            throw new BadRequestHttpException('Choose a valid optional-mod category.');
        }
        $payload = [
            'project_id' => $input['projectId'],
            'version_id' => $input['versionId'],
            'placement' => $input['placement'],
            'category_id' => $input['categoryId'] ?? null,
            'runtime' => $runtime,
            'allow_conflicts' => (bool) ($input['allowConflicts'] ?? false),
        ];
        return new JsonResponse(['plan' => (new ApplyImpulseOperation('preview'))->previewPlan($this->manager, $this->modrinth, $server, $payload)]);
    }

    public function saveRelationships(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $input = $request->validate([
            'conflicts' => ['nullable', 'array'],
            'conflicts.*' => ['array'],
            'conflicts.*.*' => ['string', 'max:128'],
            'policies' => ['nullable', 'array'],
            'policies.*' => ['in:pinned,release,beta,alpha'],
        ]);
        $relationships = $this->manager->saveRelationships($server, $input);
        return new JsonResponse(['relationships' => $relationships, 'reload' => $this->manager->reloadImpulse($server)]);
    }

    public function operation(Request $request, Server $server, string $operation): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $row = ImpulseOperation::query()->where('server_id', $server->id)->findOrFail($operation);
        return new JsonResponse($this->manager->operationPayload($row));
    }

    public function removeManagedMod(Request $request, Server $server, string $key): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $managed = $this->manager->managedFile($server, $key);
        if (!$managed) throw new BadRequestHttpException('This jar is not managed by Impulse Mod Manager.');
        $operation = ImpulseOperation::create([
            'id' => (string) Str::uuid(), 'server_id' => $server->id, 'actor_id' => $request->user()->id,
            'state' => 'queued', 'summary' => 'Removing ' . ($managed['name'] ?? $key),
            'payload' => ['type' => 'remove', 'key' => $key],
            'logs' => ['Queued. Unmanaged jars are never removed.'],
        ]);
        ApplyImpulseOperation::dispatch($operation->id);
        return new JsonResponse(['operation' => $this->manager->operationPayload($operation)], 202);
    }

    public function previewManagedUpdate(Request $request, Server $server, string $key): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $managed = $this->manager->managedFile($server, $key);
        if (!$managed || empty($managed['project_id'])) throw new BadRequestHttpException('This mod is not linked to a Modrinth project.');
        $runtime = $this->manager->detectRuntime($server);
        $this->manager->ensureRuntime($runtime);
        $policy = $managed['update_policy'] ?? 'release';
        if ($policy === 'pinned') throw new BadRequestHttpException('This mod is pinned. Change its update policy before updating it.');
        $allowed = match ($policy) {
            'alpha' => ['release', 'beta', 'alpha'],
            'beta' => ['release', 'beta'],
            default => ['release'],
        };
        $versions = $this->modrinth->versions($managed['project_id'], $runtime['minecraftVersion'], $runtime['loader']);
        $latest = collect($versions)->first(fn ($version) => in_array($version['version_type'] ?? 'release', $allowed, true));
        if (!$latest) throw new BadRequestHttpException('No compatible update is available for this mod.');
        if (($latest['id'] ?? '') === ($managed['version_id'] ?? '')) throw new BadRequestHttpException('This mod is already up to date.');
        $payload = [
            'project_id' => $managed['project_id'],
            'version_id' => $latest['id'],
            'placement' => $managed['placement'] ?? 'server',
            'category_id' => $managed['category_id'] ?? null,
            'runtime' => $runtime,
            'allow_conflicts' => false,
            'take_ownership' => true,
        ];
        $plan = (new ApplyImpulseOperation('preview'))->previewPlan($this->manager, $this->modrinth, $server, $payload);
        $file = collect($latest['files'] ?? [])->first(fn ($candidate) => !empty($candidate['primary'])) ?? ($latest['files'][0] ?? null);
        return new JsonResponse([
            'projectId' => $managed['project_id'],
            'projectName' => $managed['name'] ?? $managed['project_id'],
            'versionId' => $latest['id'],
            'versionNumber' => $latest['version_number'] ?? $latest['name'] ?? '',
            'filename' => $file['filename'] ?? '',
            'size' => (int) ($file['size'] ?? 0),
            'placement' => $payload['placement'],
            'categoryId' => $payload['category_id'],
            'updatePolicy' => $policy,
            'takeOwnership' => true,
            'plan' => $plan,
        ]);
    }

    public function dismissRestartRequired(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $this->manager->clearRestartRequired($server);
        return new JsonResponse(['restartRequired' => false]);
    }

    public function createCategory(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $category = $this->manager->createCategory($server, $request->validate([
            'folder' => ['required', 'string', 'max:80'], 'name' => ['required', 'string', 'max:100'],
            'description' => ['nullable', 'string', 'max:500'], 'default_enabled' => ['nullable', 'boolean'], 'order' => ['nullable', 'integer'],
        ]));
        return new JsonResponse(['category' => $category, 'reload' => $this->manager->reloadImpulse($server)], 201);
    }

    public function updateCategory(Request $request, Server $server, string $category): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $updated = $this->manager->updateCategory($server, $category, $request->validate([
            'folder' => ['sometimes', 'string', 'max:80'], 'id' => ['sometimes', 'string', 'max:80'], 'name' => ['sometimes', 'string', 'max:100'],
            'description' => ['nullable', 'string', 'max:500'], 'default_enabled' => ['nullable', 'boolean'], 'order' => ['nullable', 'integer'],
        ]));
        return new JsonResponse(['category' => $updated, 'reload' => $this->manager->reloadImpulse($server)]);
    }

    public function deleteCategory(Request $request, Server $server, string $category): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $this->manager->deleteCategory($server, $category);
        return new JsonResponse(['reload' => $this->manager->reloadImpulse($server)]);
    }

    public function assets(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        return new JsonResponse(['assets' => $this->manager->assets($server)]);
    }

    public function impulseConfiguration(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        return new JsonResponse(['properties' => $this->manager->properties($server), 'assets' => $this->manager->assets($server)]);
    }

    public function saveImpulseConfiguration(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $input = $request->validate(['properties' => ['required', 'array']]);
        $this->manager->saveProperties($server, $input['properties']);
        return new JsonResponse(['message' => 'Impulse configuration saved. Unknown properties and comments were preserved.', 'reload' => $this->manager->reloadImpulse($server)]);
    }

    public function content(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        return new JsonResponse(['content' => $this->manager->content($server)]);
    }

    public function saveContent(Request $request, Server $server): JsonResponse
    {
        $this->manager->authorize($request->user(), $server);
        $input = $request->validate([
            'announcements' => ['array'], 'announcements.*' => ['array'],
            'changelog' => ['array'], 'changelog.*' => ['array'],
            'events' => ['array'], 'events.*' => ['array'],
        ]);
        return new JsonResponse(['content' => $this->manager->saveContent($server, $input), 'reload' => $this->manager->reloadImpulse($server)]);
    }
}
