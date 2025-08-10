This is my QuickLookup Chrome Extension.

I put the initial prompt into spec.md for future reference, if you need it.

You can inspect the manifest.json file to see the plugin configuration.

This is my current situation:

- I can load it into the Brave browser in developer mode. I can see only Wikipedia content now. Why
  am I not seeing the other sources? I especially need Google Translate results.

- Should I use the dist folder or the root folder into the Brave extensions page? Currently, both
  seems to be working. Do I have wrong / extra configurations related to this behaviour? What is the
  correct and pragmatic approach here?

- Why isn't `a.href` recognized by IDEA in ui.ts file?

- Why isn't `s.replaceAll` recognized in links.ts?

- What are the relevant plugins to ease Chrome extension development in IntelliJ IDEA?

- What does MV3 mean in the title (Quick Lookup (MV3)) ?

- I also want to see quick AI summary just like search engines show at the top of the search results nowadays. Maybe we can smartly decide prioritization of the other knowledge based on the AI's response. For example, we give AI a brief contextual information (containing headers, URL, a few hundred chars before and after the selected text in the same semantic container etc.) beside the selected text itself and ask it to provide us a json with a useful brief summary, a type hint (movie, actor, person, animal, place etc.) so we can search other resources accordingly (IMBD for movies and actors etc.). How does it sound? Which free LLM we can use for this purpose? (it must be quick and generously free (like thousands of requests per month))
