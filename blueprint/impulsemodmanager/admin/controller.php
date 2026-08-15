<?php

namespace Pterodactyl\Http\Controllers\Admin\Extensions\impulsemodmanager;

use Illuminate\View\View;
use Illuminate\View\Factory as ViewFactory;
use Pterodactyl\Http\Controllers\Controller;
use Pterodactyl\BlueprintFramework\Libraries\ExtensionLibrary\Admin\BlueprintAdminLibrary;

class ImpulseModManagerExtensionController extends Controller
{
    public function __construct(private ViewFactory $view, private BlueprintAdminLibrary $blueprint)
    {
    }

    public function index(): View
    {
        return $this->view->make('admin.extensions.impulsemodmanager.index', [
            'root' => '/admin/extensions/impulsemodmanager',
            'blueprint' => $this->blueprint,
        ]);
    }
}
