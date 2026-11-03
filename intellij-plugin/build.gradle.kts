plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.5.0"
}

group = "com.stefanochieli"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Built against IntelliJ IDEA 2024.2; works on every newer IDE of the IntelliJ Platform
        // (IDEA, Android Studio, WebStorm, PyCharm, ...) because it only uses stable APIs.
        intellijIdeaCommunity("2024.2.4")
    }
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }
    // Plugin Marketplace signing and publishing are not set up yet: the zip is attached
    // to the GitHub Release and installed from disk.
    buildSearchableOptions = false
}

tasks.test {
    useJUnitPlatform()
}
