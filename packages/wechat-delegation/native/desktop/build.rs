fn main() {
    println!("cargo:rerun-if-changed=src/desktop.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/desktop.m")
            .flag("-fobjc-arc")
            .flag("-Wno-deprecated-declarations")
            .warnings_into_errors(true)
            .compile("clowder_desktop");
        for framework in [
            "Security",
            "CoreFoundation",
            "AppKit",
            "ApplicationServices",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
