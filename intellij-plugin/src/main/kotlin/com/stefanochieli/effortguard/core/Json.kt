package com.stefanochieli.effortguard.core

/**
 * Minimal JSON reader and writer, so the plugin needs no library beyond the JDK.
 * Objects become LinkedHashMap, arrays List, numbers Double, plus String, Boolean and null.
 */
object Json {
    fun parse(text: String): Any? {
        val p = Parser(text)
        val value = p.value()
        p.skipSpace()
        require(p.atEnd()) { "Unexpected trailing characters at ${p.pos}" }
        return value
    }

    @Suppress("UNCHECKED_CAST")
    fun parseObject(text: String): MutableMap<String, Any?> =
        parse(text) as? MutableMap<String, Any?> ?: throw IllegalArgumentException("Not a JSON object")

    fun stringify(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is Boolean -> sb.append(v)
            is Int, is Long -> sb.append(v)
            is Number -> {
                val d = v.toDouble()
                if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append(d.toLong()) else sb.append(d)
            }
            is String -> writeString(sb, v)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, x) in v) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    write(sb, x)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (x in v) {
                    if (!first) sb.append(',')
                    first = false
                    write(sb, x)
                }
                sb.append(']')
            }
            else -> writeString(sb, v.toString())
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Parser(private val s: String) {
        var pos = 0

        fun atEnd() = pos >= s.length

        fun skipSpace() {
            while (pos < s.length && s[pos].isWhitespace()) pos++
        }

        fun value(): Any? {
            skipSpace()
            require(pos < s.length) { "Unexpected end of JSON" }
            return when (val c = s[pos]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw IllegalArgumentException("Unexpected '$c' at $pos")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            require(s.startsWith(word, pos)) { "Bad literal at $pos" }
            pos += word.length
            return v
        }

        private fun num(): Double {
            val start = pos
            while (pos < s.length && (s[pos].isDigit() || s[pos] in "+-.eE")) pos++
            return s.substring(start, pos).toDouble()
        }

        private fun str(): String {
            pos++ // opening quote
            val sb = StringBuilder()
            while (true) {
                require(pos < s.length) { "Unterminated string" }
                val c = s[pos++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        require(pos < s.length) { "Unterminated escape" }
                        when (val e = s[pos++]) {
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000c')
                            'u' -> {
                                require(pos + 4 <= s.length) { "Bad unicode escape" }
                                sb.append(s.substring(pos, pos + 4).toInt(16).toChar())
                                pos += 4
                            }
                            else -> sb.append(e)
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun arr(): List<Any?> {
            pos++
            val out = ArrayList<Any?>()
            skipSpace()
            if (pos < s.length && s[pos] == ']') {
                pos++
                return out
            }
            while (true) {
                out.add(value())
                skipSpace()
                require(pos < s.length) { "Unterminated array" }
                when (s[pos++]) {
                    ',' -> continue
                    ']' -> return out
                    else -> throw IllegalArgumentException("Expected , or ] at ${pos - 1}")
                }
            }
        }

        private fun obj(): MutableMap<String, Any?> {
            pos++
            val out = LinkedHashMap<String, Any?>()
            skipSpace()
            if (pos < s.length && s[pos] == '}') {
                pos++
                return out
            }
            while (true) {
                skipSpace()
                require(pos < s.length && s[pos] == '"') { "Expected a key at $pos" }
                val key = str()
                skipSpace()
                require(pos < s.length && s[pos++] == ':') { "Expected : at ${pos - 1}" }
                out[key] = value()
                skipSpace()
                require(pos < s.length) { "Unterminated object" }
                when (s[pos++]) {
                    ',' -> continue
                    '}' -> return out
                    else -> throw IllegalArgumentException("Expected , or } at ${pos - 1}")
                }
            }
        }
    }
}
