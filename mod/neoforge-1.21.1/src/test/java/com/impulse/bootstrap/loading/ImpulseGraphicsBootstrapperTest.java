package com.impulse.bootstrap.loading;

public final class ImpulseGraphicsBootstrapperTest {
    public static void main(String[] args) {
        check(true, "--launchTarget", "forgeclient");
        check(true, "--launchTarget=forgeclientdev");
        check(true, "--launchTarget", "forgeclientuserdev");
        check(false, "--launchTarget", "forgeserver");
        check(false, "--launchTarget=forgeserveruserdev");
        check(false, "--launchTarget");
        check(false);
    }

    private static void check(boolean expected, String... arguments) {
        if (ImpulseGraphicsBootstrapper.isClientLaunch(arguments) != expected) {
            throw new AssertionError("Incorrect early launch target detection");
        }
    }
}
