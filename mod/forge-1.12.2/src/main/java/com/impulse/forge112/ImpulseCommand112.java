package com.impulse.forge112;

import com.impulse.common.ImpulseManifestServer;
import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.text.TextComponentString;

public final class ImpulseCommand112 extends CommandBase {
    public String getName() { return "impulse"; }
    public String getUsage(ICommandSender sender) { return "/impulse reload | maintenance on [message] | maintenance off"; }
    public int getRequiredPermissionLevel() { return 3; }

    public void execute(MinecraftServer server, ICommandSender sender, String[] args) {
        ImpulseManifestServer.ReloadResult result;
        if (args.length == 1 && "reload".equalsIgnoreCase(args[0])) result = ImpulseManifestServer.reload();
        else if (args.length >= 2 && "maintenance".equalsIgnoreCase(args[0]) && "on".equalsIgnoreCase(args[1])) result = ImpulseManifestServer.setMaintenance(true, join(args, 2));
        else if (args.length == 2 && "maintenance".equalsIgnoreCase(args[0]) && "off".equalsIgnoreCase(args[1])) result = ImpulseManifestServer.setMaintenance(false, null);
        else { sender.sendMessage(new TextComponentString(getUsage(sender))); return; }
        sender.sendMessage(new TextComponentString((result.success ? "[Impulse] " : "[Impulse] Error: ") + result.message));
    }

    private static String join(String[] args, int start) {
        StringBuilder out = new StringBuilder();
        for (int i = start; i < args.length; i++) { if (out.length() > 0) out.append(' '); out.append(args[i]); }
        return out.length() == 0 ? null : out.toString();
    }
}
