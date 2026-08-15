<?php

use Illuminate\Support\Facades\Route;
use Pterodactyl\Http\Middleware\Api\Client\Server\AuthenticateServerAccess;
use Pterodactyl\BlueprintFramework\Extensions\impulsemodmanager\ImpulseManagerController;

Route::group([
    'prefix' => 'servers/{server}',
    'middleware' => [AuthenticateServerAccess::class],
], function () {
    Route::get('/overview', [ImpulseManagerController::class, 'overview']);
    Route::put('/runtime', [ImpulseManagerController::class, 'saveRuntimeOverride']);
    Route::get('/modrinth/search', [ImpulseManagerController::class, 'searchModrinth']);
    Route::get('/modrinth/projects/{project}/versions', [ImpulseManagerController::class, 'projectVersions']);
    Route::get('/modrinth/projects/{project}', [ImpulseManagerController::class, 'projectDetails']);
    Route::post('/operations', [ImpulseManagerController::class, 'createOperation']);
    Route::post('/operations/preview', [ImpulseManagerController::class, 'previewOperation']);
    Route::get('/operations/{operation}', [ImpulseManagerController::class, 'operation']);
    Route::delete('/mods/{key}', [ImpulseManagerController::class, 'removeManagedMod']);
    Route::post('/mods/{key}/update/preview', [ImpulseManagerController::class, 'previewManagedUpdate']);
    Route::post('/restart-required/dismiss', [ImpulseManagerController::class, 'dismissRestartRequired']);
    Route::post('/categories', [ImpulseManagerController::class, 'createCategory']);
    Route::patch('/categories/{category}', [ImpulseManagerController::class, 'updateCategory']);
    Route::delete('/categories/{category}', [ImpulseManagerController::class, 'deleteCategory']);
    Route::get('/assets', [ImpulseManagerController::class, 'assets']);
    Route::get('/impulse/configuration', [ImpulseManagerController::class, 'impulseConfiguration']);
    Route::put('/impulse/configuration', [ImpulseManagerController::class, 'saveImpulseConfiguration']);
    Route::put('/relationships', [ImpulseManagerController::class, 'saveRelationships']);
    Route::get('/content', [ImpulseManagerController::class, 'content']);
    Route::put('/content', [ImpulseManagerController::class, 'saveContent']);
});
