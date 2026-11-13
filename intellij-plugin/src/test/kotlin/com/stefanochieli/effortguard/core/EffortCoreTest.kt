package com.stefanochieli.effortguard.core

import java.nio.file.Files
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EffortCoreTest {
    private fun state(
        streak: Int = 0, calm: Int = 0, threshold: Int? = 3, calmThreshold: Int? = 8, struggling: Boolean = false,
        source: String? = null, cwd: String? = "/p", updated: String? = null,
    ) = EffortState(
        cwd, streak, calm, threshold, calmThreshold, struggling, null, emptyList(), updated,
        source?.let { SessionInfo(it, "abc", null) }, emptyList(),
    )

    @Test
    fun jsonRoundTrip() {
        val text = """{"a":1,"b":[true,false,null,"x\ny\u00e9"],"c":{"d":-2.5e1},"e":""}"""
        val parsed = Json.parseObject(text)
        assertEquals(1.0, parsed["a"])
        assertEquals(listOf(true, false, null, "x\nyé"), parsed["b"])
        assertEquals(-25.0, (parsed["c"] as Map<*, *>)["d"])
        assertEquals(parsed, Json.parseObject(Json.stringify(parsed)))
        assertEquals("""{"n":3,"s":"a\"b"}""", Json.stringify(linkedMapOf("n" to 3.0, "s" to "a\"b")))
    }

    @Test
    fun levels() {
        assertEquals(Level.IDLE, EffortCore.levelOf(null))
        assertEquals(Level.OK, EffortCore.levelOf(state()))
        assertEquals(Level.WATCH, EffortCore.levelOf(state(streak = 1)))
        assertEquals(Level.WATCH, EffortCore.levelOf(state(struggling = true)))
        assertEquals(Level.WARN, EffortCore.levelOf(state(streak = 3)))
        assertEquals(Level.CALM, EffortCore.levelOf(state(calm = 8)))
    }

    @Test
    fun textBarAndAdvice() {
        assertEquals("\u25B0\u25B1\u25B1", EffortCore.textBar(1, 3))
        val warn = EffortCore.computeView(state(streak = 3))
        assertEquals(Action.THINKING_UP, warn.action)
        assertTrue(warn.hint!!.contains("raise the thinking"))
        val escalate = EffortCore.computeView(state(streak = 6))
        assertEquals(Action.MODEL_UP, escalate.action)
        assertTrue(escalate.hint!!.contains("more powerful model"))
        val calm = EffortCore.computeView(state(calm = 9, source = "cli@vscode"))
        assertEquals(Action.DOWN, calm.action)
        assertEquals("CLI", calm.kind)
        assertTrue(calm.hint!!.endsWith("(CLI session)"))
        assertEquals("Chat", sessionKind("vscode-chat"))
        assertEquals(Level.IDLE, EffortCore.computeView(null).level)
    }

    @Test
    fun notifications() {
        assertEquals(Notice.WARN, EffortCore.shouldNotify(state(streak = 2), state(streak = 3)))
        assertNull(EffortCore.shouldNotify(state(streak = 3), state(streak = 4)))
        assertEquals(Notice.ESCALATE, EffortCore.shouldNotify(state(streak = 5), state(streak = 6)))
        assertEquals(Notice.CALM, EffortCore.shouldNotify(state(calm = 7), state(calm = 8)))
        assertNull(EffortCore.shouldNotify(state(calm = 8), state(calm = 9)))
        assertNull(EffortCore.shouldNotify(null, null))
    }

    @Test
    fun findStateMatchesSubfoldersNewestFirst() {
        val dir = Files.createTempDirectory("eg-find")
        fun p(cwd: String, updated: String) = Project(dir, mapOf("cwd" to cwd, "updated" to updated))
        val projects = listOf(
            p("C:\\Users\\x\\proj\\sub", "2026-11-02T10:00:00Z"),
            p("C:\\Users\\x\\proj", "2026-11-02T12:00:00Z"),
            p("C:\\Users\\x\\other", "2026-11-02T13:00:00Z"),
        )
        assertEquals("C:\\Users\\x\\proj", EffortCore.findState(projects, listOf("c:\\users\\x\\PROJ"))?.state?.cwd)
        assertNull(EffortCore.findState(projects, listOf("C:\\Users\\x\\proj2")))
        assertTrue(EffortCore.isInside("/a/b/c", "/a/b"))
        assertFalse(EffortCore.isInside("/a/bc", "/a/b"))
    }

    @Test
    fun resetClearsStreaksAndKeepsHistory() {
        val home = Files.createTempDirectory("eg-home")
        val dir = home.resolve("effort-guard/state/abc")
        Files.createDirectories(dir)
        Files.writeString(
            dir.resolve("state.json"),
            """{"streak":4,"calm":0,"cwd":"/p","log":[{"struggled":true}],"turn":{"struggled":true,"reason":"x","command":null}}""",
        )
        val found = EffortCore.readProjects(home)
        assertEquals(1, found.size)
        assertEquals(4, found[0].state.streak)
        EffortCore.resetProject(dir, Instant.parse("2026-11-03T10:00:00Z"))
        val after = EffortCore.readProjects(home)[0]
        assertEquals(0, after.state.streak)
        assertFalse(after.state.struggling)
        assertEquals(1, after.state.log.size)
        assertEquals("/p", after.state.cwd)
        assertEquals("2026-11-03T10:00:00Z", after.raw["resetAt"])
        assertNotNull(EffortCore.computeView(after.state, after.raw).resetAt)
    }

    @Test
    fun ageText() {
        val now = Instant.parse("2026-11-03T10:10:00Z")
        assertEquals("7s ago", EffortCore.ageText("2026-11-03T10:09:53Z", now))
        assertEquals("3 min ago", EffortCore.ageText("2026-11-03T10:07:00Z", now))
        assertEquals("-", EffortCore.ageText(null, now))
        assertEquals("-", EffortCore.ageText("nope", now))
    }

    private val shared: Map<String, Any?> =
        Json.parseObject(Files.readString(java.nio.file.Paths.get("..", "tests", "fixtures", "shared", "views.json")))

    @Suppress("UNCHECKED_CAST")
    private fun rawOf(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

    /** Same cases as tests/extension.test.mjs: the two extensions must agree. */
    @Test
    fun sharedFixtures() {
        for (c in shared["views"] as List<*>) {
            val case = c as Map<*, *>
            val name = case["name"].toString()
            val raw = rawOf(case["state"])
            val view = EffortCore.computeView(raw?.let { EffortCore.toState(it) }, raw)
            assertEquals(case["level"], view.level.name.lowercase(), name)
            assertEquals(case["action"], view.action?.id, name)
            assertEquals(case["hint"], view.hint, name)
            case["bar"]?.let { assertEquals(it, EffortCore.textBar(view.streak, view.threshold), name) }
        }
        for (n in shared["notify"] as List<*>) {
            val case = n as Map<*, *>
            val prev = rawOf(case["prev"])?.let { EffortCore.toState(it) }
            val cur = rawOf(case["cur"])?.let { EffortCore.toState(it) }
            assertEquals(case["notice"], EffortCore.shouldNotify(prev, cur)?.name?.lowercase(), case.toString())
        }
    }

    @Test
    fun perRepoStateAndCache() {
        val home = Files.createTempDirectory("eg-home")
        val repo = Files.createTempDirectory("eg-repo")
        Files.createDirectories(repo.resolve(".effort-guard"))
        val file = repo.resolve(".effort-guard").resolve("state.json")
        Files.writeString(file, """{"streak":1,"log":[]}""")
        val projects = EffortCore.readProjects(home, listOf(repo.toString()))
        assertEquals(1, projects.size)
        assertEquals(repo.toString(), projects[0].state.cwd)
        val first = EffortCore.readRaw(file)
        assertTrue(first === EffortCore.readRaw(file), "unchanged file is not parsed again")
        Files.writeString(file, """{"streak":""")
        Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 5000))
        assertEquals(1.0, EffortCore.readRaw(file)?.get("streak"), "half-written file: last good copy")
        Files.writeString(file, """{"streak":4,"log":[],"turn":{}}""")
        Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 10000))
        EffortCore.resetProject(file.parent)
        assertEquals(listOf("state.json"), Files.list(file.parent).use { s -> s.map { it.fileName.toString() }.toList() })
        assertEquals(0.0, EffortCore.readRaw(file)?.get("streak"))
    }

    @Test
    fun sharedHistory() {
        for (h in shared["history"] as List<*>) {
            val case = h as Map<*, *>
            val entries = EffortCore.toState(mapOf("log" to case["log"])).entries
            val days = EffortCore.dailyHistory(entries, (case["days"] as Number).toInt(), Instant.parse(case["now"] as String))
            val expected = (case["expected"] as List<*>).map {
                val d = it as Map<*, *>
                DayCount(d["day"] as String, (d["turns"] as Number).toInt(), (d["struggling"] as Number).toInt())
            }
            assertEquals(expected, days)
            val reasons = (case["reasons"] as List<*>).map { val r = it as List<*>; (r[0] as String) to (r[1] as Number).toInt() }
            assertEquals(reasons, EffortCore.reasonCounts(entries))
        }
    }

    @Test
    fun thresholdsFileKeepsOtherKeys() {
        val dir = Files.createTempDirectory("eg-cfg")
        Files.writeString(dir.resolve(".effort-guard.json"), """{"note":"team"}""")
        EffortCore.writeConfig(dir, 4, 10)
        val cfg = EffortCore.readConfig(dir)
        assertEquals("team", cfg["note"])
        assertEquals(4.0, cfg["threshold"])
        assertEquals(10.0, cfg["calmThreshold"])
    }

    private fun entryOf(m: Any?) = EffortCore.toState(mapOf("log" to listOf(m))).entries.single()

    /** Same cases as tests/extension.test.mjs and src/quality.mjs. */
    @Test
    fun sharedQuality() {
        val q = shared["quality"] as Map<*, *>
        for (c in q["entries"] as List<*>) {
            val case = c as Map<*, *>
            assertEquals((case["quality"] as? Number)?.toDouble(), EffortCore.qualityOf(entryOf(case["entry"])), case.toString())
        }
        for (c in q["summaries"] as List<*>) {
            val case = c as Map<*, *>
            val entries = EffortCore.toState(mapOf("log" to case["log"])).entries
            val r = EffortCore.qualitySummary(entries)
            assertEquals((case["score"] as? Number)?.toInt(), r.score, case.toString())
            assertEquals(case["level"], r.level, case.toString())
            assertEquals((case["rated"] as Number).toInt(), r.rated, case.toString())
        }
    }

    @Test
    fun voteOnLastTurn() {
        val dir = Files.createTempDirectory("eg-vote")
        Files.writeString(dir.resolve("state.json"), """{"streak":0,"turn":{},"log":[{"ts":"t","struggled":false,"tests":"red"}]}""")
        assertEquals("up", EffortCore.voteLast(dir, "up"))
        assertEquals(100, EffortCore.qualitySummary(EffortCore.toState(EffortCore.readRaw(dir.resolve("state.json"))!!).entries).score)
        assertNull(EffortCore.voteLast(dir, "up"))
        assertEquals(listOf("state.json"), Files.list(dir).use { s -> s.map { it.fileName.toString() }.toList() })
    }

    @Test
    fun lanesAreReadAndResetTogether() {
        val raw = Json.parseObject(
            """{"streak":0,"turn":{},"log":[],"threshold":3,"lanes":{"chat":{"streak":2,"turn":{"struggled":true,"reason":"tool_error"},"last":"2026-11-13T10:00:00Z"},"cli":{"streak":0,"calm":4,"turn":{},"last":"2026-11-13T10:05:00Z"}}}""",
        )
        val state = EffortCore.toState(raw)
        assertEquals(listOf("Chat", "CLI"), state.lanes.map { it.label })
        assertEquals(2, state.streak)
        assertEquals("Chat", state.lane)
        assertTrue(state.struggling)
        val reset = EffortCore.toState(EffortCore.resetRaw(raw))
        assertEquals(listOf(0, 0), reset.lanes.map { it.streak })
        assertFalse(reset.struggling)
        assertEquals(0, reset.lanes.single { it.kind == "cli" }.calm)
    }
}
