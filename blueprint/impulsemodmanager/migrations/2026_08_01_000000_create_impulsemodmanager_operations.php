<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('impulsemodmanager_operations', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->unsignedInteger('server_id')->index();
            $table->unsignedInteger('actor_id')->nullable();
            $table->string('state', 32)->default('queued');
            $table->string('summary');
            $table->json('payload');
            $table->json('logs')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('impulsemodmanager_operations');
    }
};
