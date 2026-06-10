import localUnitTest from './LocalUnit.test';
import a2uiParserTest from './A2uiParser.test';
import localModelClientTest from './LocalModelClient.test';

export default function testsuite() {
  localUnitTest();
  a2uiParserTest();
  localModelClientTest();
}
