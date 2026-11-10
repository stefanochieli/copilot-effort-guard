package com.stefanochieli.effortguard.core

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import java.time.Instant

// Pure logic of the plugin (no IntelliJ imports, testable with plain JUnit).
// It mirrors vscode-extension/lib.js: both read the state.json files written by the
// copilot-effort-guard hooks in ~/.copilot/effort-guard/state/<hash>/state.json.

const val DEFAULT_THRESHOLD = 3
const val DEFAULT_CALM = 8

enum class Level(val label: String, val hex: String, val emoji: String) {
    IDLE("No data yet", "#8b949e", "⚪"),
    OK("All good", "#3fb950", "🟢"),
    CALM("Very smooth", "#58a6ff", "🔵"),
    WATCH("Some struggle", "#d29922", "🟡"),
    WARN("Struggling", "#f85149", "🔴"),
}

enum class Action(val badge: String, val id: String) {
    THINKING_UP("↑ Raise thinking", "thinking-up"),
    MODEL_UP("↑↑ Upgrade model", "model-up"),
    DOWN("↓ Downgrade", "down"),
}

enum class Notice { WARN, ESCALATE, CALM }

data class SessionInfo(val source: String?, val id: String?, val last: String?) {
    val kind: String? get() = sessionKind(source)
}

/** 'vscode-chat' -> Chat, 'cli' and 'cli@vscode' -> CLI. */
fun sessionKind(source: String?): String? = when {
    source == null -> null
    source.startsWith("cli") -> "CLI"
    source == "vscode-chat" -> "Chat"
    else -> null
}

data class EffortState(
    val cwd: String?,
    val streak: Int,
    val calm: Int,
    val threshold: Int?,
    val calmThreshold: Int?,
    val struggling: Boolean,
    val reason: String?,
    val log: List<Boolean>,
    val updated: String?,
    val session: SessionInfo?,
    val sessions: List<SessionInfo>,
)

data class Messages(val warn: String, val escalate: String, val calm: String)

data class EffortView(
    val level: Level,
    val text: String,
    val tooltip: String,
    val streak: Int,
    val threshold: Int,
    val calm: Int,
    val calmThreshold: Int,
    val segments: Int,
    val filled: Int,
    val timeline: List<Boolean>,
    val action: Action?,
    val hint: String?,
    val messages: Messages,
    val kind: String?,
    val session: SessionInfo?,
    val sessions: List<SessionInfo>,
    val cwd: String?,
    val updated: String?,
    val resetAt: String?,
)

/** One state.json found on disk: its folder and the raw JSON (kept whole, so a reset loses nothing). */
class Project(val dir: Path, val raw: Map<String, Any?>) {
    val state: EffortState = EffortCore.toState(raw)
}

object EffortCore {
    private fun num(v: Any?): Int? = (v as? Number)?.toInt()

    private fun session(v: Any?): SessionInfo? {
        val m = v as? Map<*, *> ?: return null
        return SessionInfo(m["source"] as? String, m["id"]?.toString(), m["last"] as? String)
    }

    fun toState(raw: Map<String, Any?>): EffortState {
        val turn = raw["turn"] as? Map<*, *>
        val log = (raw["log"] as? List<*>).orEmpty().map { (it as? Map<*, *>)?.get("struggled") == true }
        return EffortState(
            cwd = raw["cwd"] as? String,
            streak = num(raw["streak"]) ?: 0,
            calm = num(raw["calm"]) ?: 0,
            threshold = num(raw["threshold"]),
            calmThreshold = num(raw["calmThreshold"]),
            struggling = turn?.get("struggled") == true,
            reason = turn?.get("reason") as? String,
            log = log,
            updated = raw["updated"] as? String,
            session = session(raw["session"]),
            sessions = (raw["sessions"] as? List<*>).orEmpty().mapNotNull { session(it) },
        )
    }

    fun copilotHome(env: Map<String, String> = System.getenv(), userHome: String = System.getProperty("user.home")): Path {
        val fromEnv = env["COPILOT_HOME"]
        return if (!fromEnv.isNullOrBlank()) Paths.get(fromEnv) else Paths.get(userHome, ".copilot")
    }

    private class Cached(val modified: Long, val size: Long, val raw: Map<String, Any?>)

    /** Parsed state files by path, reused while their time stamp and size do not change. */
    private val cache = ConcurrentHashMap<Path, Cached>()

    /** Reads one state.json; a half-written file returns the last good copy. */
    fun readRaw(file: Path): Map<String, Any?>? {
        val modified: Long
        val size: Long
        try {
            modified = Files.getLastModifiedTime(file).toMillis()
            size = Files.size(file)
        } catch (_: Exception) {
            cache.remove(file)
            return null
        }
        val hit = cache[file]
        if (hit != null && hit.modified == modified && hit.size == size) return hit.raw
        return try {
            val raw = Json.parseObject(Files.readString(file).removePrefix("\uFEFF"))
            cache[file] = Cached(modified, size, raw)
            raw
        } catch (_: Exception) {
            hit?.raw
        }
    }

    /**
     * Reads every <home>/effort-guard/state/<hash>/state.json (per-user install) and
     * <folder>/.effort-guard/state.json of the given project folders (per-repo install).
     * Unreadable files are skipped.
     */
    fun readProjects(home: Path, folders: List<String> = emptyList()): List<Project> {
        val dirs = ArrayList<Path>()
        val root = home.resolve("effort-guard").resolve("state")
        if (Files.isDirectory(root)) {
            try {
                Files.newDirectoryStream(root).use { ds -> ds.forEach { dirs.add(it) } }
            } catch (_: Exception) {
            }
        }
        folders.forEach { dirs.add(Paths.get(it).resolve(".effort-guard")) }
        return dirs.mapNotNull { dir ->
            val raw = readRaw(dir.resolve("state.json")) ?: return@mapNotNull null
            Project(dir, if (raw["cwd"] is String) raw else raw + ("cwd" to dir.parent.toString()))
        }
    }

    private fun norm(p: String): String {
        val s = p.replace('\\', '/').trimEnd('/')
        val windows = Regex("^[a-zA-Z]:").containsMatchIn(s) || p.contains('\\')
        return if (windows) s.lowercase() else s
    }

    fun isInside(cwd: String, folder: String): Boolean {
        val c = norm(cwd)
        val f = norm(folder)
        return c == f || c.startsWith("$f/")
    }

    /** The most recently used project whose cwd is a workspace folder or one of its subfolders. */
    fun findState(projects: List<Project>, folders: List<String>): Project? =
        projects
            .filter { p -> p.state.cwd != null && folders.any { isInside(p.state.cwd!!, it) } }
            .maxByOrNull { it.state.updated ?: "" }

    /** Starts the evaluation again (after changing model or thinking effort); keeps the history. */
    fun resetRaw(raw: Map<String, Any?>, now: Instant = Instant.now()): Map<String, Any?> {
        val next = LinkedHashMap(raw)
        next["turn"] = linkedMapOf<String, Any?>("struggled" to false, "reason" to null, "command" to null)
        next["streak"] = 0
        next["calm"] = 0
        next["pendingWarning"] = null
        next["started"] = true
        next["resetAt"] = now.toString()
        return next
    }

    fun resetProject(dir: Path, now: Instant = Instant.now()) {
        val file = dir.resolve("state.json")
        val next = resetRaw(Json.parseObject(Files.readString(file)), now)
        // Temporary file + atomic rename: the hooks never read a half-written state.
        val tmp = file.resolveSibling("state.json.${ProcessHandle.current().pid()}.ide.tmp")
        Files.writeString(tmp, Json.stringify(next))
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
        }
        cache.remove(file)
    }

    fun levelOf(state: EffortState?, fallbackThreshold: Int = DEFAULT_THRESHOLD): Level {
        if (state == null) return Level.IDLE
        val threshold = state.threshold ?: fallbackThreshold
        val calmThreshold = state.calmThreshold ?: DEFAULT_CALM
        return when {
            state.streak >= threshold -> Level.WARN
            state.streak > 0 || state.struggling -> Level.WATCH
            state.calm >= calmThreshold -> Level.CALM
            else -> Level.OK
        }
    }

    /** One segment per allowed struggling turn (max 10), filled by the current streak. */
    fun textBar(streak: Int, threshold: Int): String {
        val segments = threshold.coerceIn(1, 10)
        val filled = streak.coerceAtMost(segments)
        return "▰".repeat(filled) + "▱".repeat(segments - filled)
    }

    fun adviceMessages(streak: Int, threshold: Int, calm: Int) = Messages(
        warn = "${maxOf(streak, threshold)} struggling turns in a row: raise the thinking / reasoning effort, the task may need more deliberation.",
        escalate = "${maxOf(streak, threshold * 2)} struggling turns in a row, more thinking did not help: switch to a more powerful model.",
        calm = "$calm clean turns in a row, the task looks easy: downgrade to a lighter model or lower the thinking effort to save tokens.",
    )

    fun computeView(state: EffortState?, raw: Map<String, Any?>? = null, fallbackThreshold: Int = DEFAULT_THRESHOLD): EffortView {
        if (state == null) {
            return EffortView(
                level = Level.IDLE, text = "Effort -",
                tooltip = "Effort Guard: no data for this folder yet. Use Copilot agent mode or the CLI here.",
                streak = 0, threshold = fallbackThreshold, calm = 0, calmThreshold = DEFAULT_CALM,
                segments = fallbackThreshold.coerceIn(1, 10), filled = 0, timeline = emptyList(),
                action = null, hint = null, messages = adviceMessages(0, fallbackThreshold, 0),
                kind = null, session = null, sessions = emptyList(), cwd = null, updated = null, resetAt = null,
            )
        }
        val threshold = state.threshold ?: fallbackThreshold
        val calmThreshold = state.calmThreshold ?: DEFAULT_CALM
        val level = levelOf(state, fallbackThreshold)
        val messages = adviceMessages(state.streak, threshold, state.calm)
        val action = when (level) {
            Level.WARN -> if (state.streak >= threshold * 2) Action.MODEL_UP else Action.THINKING_UP
            Level.CALM -> Action.DOWN
            else -> null
        }
        val kind = sessionKind(state.session?.source)
        val tag = if (kind != null) " ($kind session)" else ""
        val base = when (action) {
            Action.MODEL_UP -> messages.escalate
            Action.THINKING_UP -> messages.warn
            Action.DOWN -> messages.calm
            null -> null
        }
        val hint = base?.let { it + tag }
        val lines = ArrayList<String>()
        lines.add("Effort Guard: ${state.streak}/$threshold struggling turns in a row")
        lines.add("Turns logged: ${state.log.size}, struggling: ${state.log.count { it }}")
        if (state.struggling) lines.add("Current turn: struggling (${state.reason})")
        if (hint != null) lines.add(hint)
        return EffortView(
            level = level,
            text = "${level.emoji} ${textBar(state.streak, threshold)} ${state.streak}/$threshold",
            tooltip = lines.joinToString("\n"),
            streak = state.streak, threshold = threshold, calm = state.calm, calmThreshold = calmThreshold,
            segments = threshold.coerceIn(1, 10), filled = state.streak.coerceAtMost(threshold.coerceIn(1, 10)),
            timeline = state.log.takeLast(24),
            action = action, hint = hint, messages = messages,
            kind = kind, session = state.session, sessions = state.sessions,
            cwd = state.cwd, updated = state.updated, resetAt = raw?.get("resetAt") as? String,
        )
    }

    /** Which notification to show, if any: when the streak crosses the threshold, twice the threshold, or the calm threshold. */
    fun shouldNotify(prev: EffortState?, cur: EffortState?, fallbackThreshold: Int = DEFAULT_THRESHOLD): Notice? {
        if (cur == null) return null
        val threshold = cur.threshold ?: fallbackThreshold
        val prevStreak = prev?.streak ?: 0
        if (cur.streak >= threshold * 2 && prevStreak < threshold * 2) return Notice.ESCALATE
        if (cur.streak >= threshold && prevStreak < threshold) return Notice.WARN
        val calmThreshold = cur.calmThreshold ?: DEFAULT_CALM
        if (cur.calm >= calmThreshold && (prev?.calm ?: 0) < calmThreshold) return Notice.CALM
        return null
    }

    fun ageText(iso: String?, now: Instant = Instant.now()): String {
        if (iso == null) return "-"
        val t = try { Instant.parse(iso) } catch (_: Exception) { return "-" }
        val s = maxOf(0L, now.epochSecond - t.epochSecond)
        return when {
            s < 60 -> "${s}s ago"
            s < 3600 -> "${s / 60} min ago"
            s < 86400 -> "${s / 3600} h ago"
            else -> "${s / 86400} d ago"
        }
    }
}
