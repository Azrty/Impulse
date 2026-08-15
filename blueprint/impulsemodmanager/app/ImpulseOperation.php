<?php

namespace Pterodactyl\BlueprintFramework\Extensions\impulsemodmanager;

use Illuminate\Database\Eloquent\Model;

class ImpulseOperation extends Model
{
    protected $table = 'impulsemodmanager_operations';
    public $incrementing = false;
    protected $keyType = 'string';
    protected $guarded = [];
    protected $casts = [
        'payload' => 'array',
        'logs' => 'array',
    ];
}
