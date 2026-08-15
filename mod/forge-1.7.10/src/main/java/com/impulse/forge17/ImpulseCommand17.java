package com.impulse.forge17;

import com.impulse.common.ImpulseManifestServer;
import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.util.ChatComponentText;

public final class ImpulseCommand17 extends CommandBase {
    public String getCommandName() { return "impulse"; }
    public String getCommandUsage(ICommandSender sender) { return "/impulse reload | maintenance on [message] | maintenance off"; }
    public int getRequiredPermissionLevel() { return 3; }

    public void processCommand(ICommandSender sender, String[] args) {
        ImpulseManifestServer.ReloadResult result;
        if (args.length == 1 && "reload".equalsIgnoreCase(args[0])) result = ImpulseManifestServer.reload();
        else if (args.length >= 2 && "maintenance".equalsIgnoreCase(args[0]) && "on".equalsIgnoreCase(args[1])) result = ImpulseManifestServer.setMaintenance(true, join(args, 2));
        else if (args.length == 2 && "maintenance".equalsIgnoreCase(args[0]) && "off".equalsIgnoreCase(args[1])) result = ImpulseManifestServer.setMaintenance(false, null);
        else { sender.addChatMessage(new ChatComponentText(getCommandUsage(sender))); return; }
        sender.addChatMessage(new ChatComponentText((result.success ? "[Impulse] " : "[Impulse] Error: ") + result.message));
    }

    private static String join(String[] args, int start) {
        StringBuilder out = new StringBuilder();
        for (int i = start; i < args.length; i++) { if (out.length() > 0) out.append(' '); out.append(args[i]); }
        return out.length() == 0 ? null : out.toString();
    }
}
